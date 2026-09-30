# better_screening-BE

Backend for **Better Screening** — a multi-tenant AI recruitment/interview platform.
NestJS + PostgreSQL/TypeORM for relational data, Redis/BullMQ for the async
speech-to-text and evaluation pipeline. See the full architecture and build plan at
`/home/prince/.claude/plans/hi-this-is-merry-milner.md` (or wherever it's been moved to
in this repo going forward).

## Status: Phase 5 — LLM integration (evaluation, question generation, email drafting)

What's implemented so far:
- Project scaffold (NestJS 11, TypeScript, path aliases `@config/*` `@core/*` `@module/*`,
  ESLint/Prettier, Jest unit + e2e config).
- `docker-compose.yml`: Postgres, Redis, MinIO (+ bucket bootstrap), Maildev (local SMTP
  inbox for dev).
- Core cross-cutting pieces: global exception filter + response envelope
  (`{isError, message, data}`), env loader (no `@nestjs/config`), JWT (`@nestjs/jwt` +
  `@nestjs/passport`), a `MailService` (nodemailer), `StorageService` (S3-compatible,
  AWS SDK v3 — presigned upload/download URLs, works against MinIO or real S3).
- `OrganizationsModule`, `UsersModule`, `AuthModule` — org signup/login, team invite,
  password reset.
- `JobsModule` — jobs with nested skills + interview round templates + per-round
  questions.
- `CandidatesModule` — candidate CRUD, forward-only stage transitions, notes.
- `InterviewsModule` — schedule/reschedule/cancel, send-invitation (now issues a real
  candidate access token and emails the real interview-room link).
- `InterviewSessionModule` — the **candidate portal** backend: token-only auth (no JWT,
  no account), session fetch (reports per-question answered state for resumability),
  LiveKit room join (starts the round clock on first join), per-question server-side
  recording via LiveKit Egress (one MP4 per question, written straight into the
  recordings bucket), submit (idempotent), and lazy deadline enforcement that
  auto-submits a round whose time ran out (also triggered when the candidate leaves the
  room). Egress results arrive on a signed webhook (`POST /v1/livekit/webhook`);
  transcription is enqueued only once the round is submitted **and** every recording has
  settled. Recruiters get `GET /v1/interviews/:id/recordings` (signed playback URLs +
  per-question transcript).
- `TranscriptIngestionModule` — the hand-off boundary with the **transcription service**
  (`../transcript`, Python + Deepgram, run separately — see below). On submit, each
  recorded answer's MP4 is copied from the recordings bucket into the shared audio folder
  and a `transcription` job is queued (one per answer, `id` = answer id). The
  `transcription-events` consumer reads the finished text from the service's HTTP API,
  saves it on the answer (`interview_answers.transcriptText` + timed segments), deletes
  the copied audio, and — once every answer is done — assembles `interview_transcripts`
  and forwards to the internal `evaluation-processing` queue. Idempotent against
  BullMQ's at-least-once delivery; events for ids that aren't ours are ignored.

- `LlmModule` (`src/core/llm`) — a thin, generic "prompt in, structured JSON out"
  wrapper over the Anthropic API (`@anthropic-ai/sdk`), config-driven via
  `LLM_PROVIDER`/`LLM_API_KEY`/`LLM_MODEL`. `LLM_PROVIDER=mock` makes every call site
  return its own deterministic canned response instead of a real call — useful for
  local dev/testing without a key (set it in your own `.env`; `.env.example` documents
  the real default, `anthropic`).
- `EvaluationModule` — owns the actual evaluation logic (resume × job description ×
  transcript), entirely our own LLM call, never the STT vendor's. Consumes the
  internal `evaluation-processing` queue, validates the LLM's structured response
  before persisting anything, writes `interview_summaries` +
  `interview_question_analyses` in one transaction, flips the interview to
  `completed`, and updates the candidate's `overallScore`. Idempotent (skips if a
  summary already exists for the interview) and exposes
  `GET /interviews/:id/evaluation` (status: `not_submitted` / `transcribing` /
  `transcription_failed` / `evaluating` / `completed`) plus
  `POST /interviews/:id/retry-evaluation` (re-enqueues; explicitly retries a job still
  sitting in BullMQ's failed set rather than silently no-opping against it).
- `JobsModule` gained `POST /jobs/:id/rounds/:roundId/questions/generate` — an LLM
  question-suggestion endpoint (nothing persisted; the recruiter edits/keeps/discards
  before saving via the normal job-update endpoint).
- `EmailComposerModule` (new) — `POST /candidates/:id/emails/compose` (LLM draft,
  nothing sent yet), `POST /candidates/:id/emails/send` (sends via `MailService` and
  logs to `candidate_emails`), `GET /candidates/:id/emails` (history).

Not yet built (see the plan file's build order): notifications, dashboard
KPIs/activity feed, search, team management UI, settings pages.

### Candidate portal API (token-only, no JWT)

```
GET  /interview-session/:token                                  session + questions
POST /interview-session/:token/livekit/join                       LiveKit url + publish-only token; starts the clock
POST /interview-session/:token/questions/:questionId/recording/start  start Egress for this question
POST /interview-session/:token/questions/:questionId/recording/stop   stop it (file confirmed via webhook)
POST /interview-session/:token/submit                            finish the round
```

### AI pipeline queues (BullMQ / Redis, default `bull` prefix)

```
transcription            we produce (one job per answer: {id, audioPath, metadata}), the
                         transcription service consumes; audio is read from the shared
                         folder by relative path — never a URL
transcription-events     the service produces transcription.completed / .failed (no text);
                         we consume and fetch the text from GET <TRANSCRIPTION_API_URL>/jobs/:id
evaluation-processing    fully internal — our own producer/consumer (EvaluationModule)
```

## Getting started

```bash
cp .env.example .env      # adjust if your local ports differ
npm install

# Start Postgres, Redis, MinIO (+ bucket bootstrap), Maildev, LiveKit + Egress
docker compose up -d postgres redis minio minio-init maildev livekit livekit-egress

# Run the first migration
npm run migration:run

npm run start:dev         # http://localhost:3000, Swagger at /docs
```

### Transcription service (`../transcript`)

Runs separately in its own folder. `transcript/docker-compose.override.yml` (loaded
automatically) points it at **this** backend's Redis on host port 6379, disables its own
Redis, moves its Postgres to host port 5435, and bind-mounts `transcript/data/audio` as
its `/data/audio` — the folder this backend writes recordings into
(`TRANSCRIPTION_AUDIO_DIR=../transcript/data/audio`). Start the backend's Redis first.

```bash
cd ../transcript
cp .env.example .env            # set DEEPGRAM_API_KEY (first time only)
mkdir -p data/audio
docker compose up -d --build    # postgres(:5435) + migrate + worker + api(:8000)
curl localhost:8000/health      # {"status":"ok","database":true,…}
docker compose logs -f worker   # watch jobs being transcribed
curl localhost:8000/jobs/<answerId>   # a job's status + transcript
docker compose down             # stop it
```

### LiveKit (interview video)

`livekit` and `livekit-egress` run with host networking (Linux; WebRTC needs UDP
50000–50100 and TCP 7881). Config is in `livekit/livekit.yaml` and `livekit/egress.yaml`;
their API key/secret must match `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in `.env`, and
the server posts webhooks to `http://localhost:3000/v1/livekit/webhook`. Egress writes
recordings to MinIO at `LIVEKIT_EGRESS_S3_ENDPOINT` using the `STORAGE_*` credentials.
For LiveKit Cloud, point `LIVEKIT_API_URL` / `LIVEKIT_WS_URL` at your project and set
its webhook URL to the backend's public `/v1/livekit/webhook`.

> If you already run Postgres locally on 5432, this compose file maps the container to
> host port **5433** instead (see `docker-compose.yml` and `.env.example`) to avoid the
> clash — the `app` service itself still talks to `postgres:5432` over the internal
> Docker network, unaffected.

### Useful scripts

```bash
npm run build              # tsc build
npm run lint                # eslint --fix
npm test                    # unit tests (*.spec.ts)
npm run test:e2e            # e2e tests — needs docker compose services running
npm run migration:generate -- src/core/database/migrations/SomeName
npm run migration:run
npm run migration:revert
```

### Conventions

- Feature modules live under `src/modules/<feature>/{*.module,*.controller,*.service,dto/,entities/}`.
- Cross-cutting concerns live under `src/core/{database,queue,mail,jwt,dispatchers,logger,utils}`.
- Every tenant-scoped entity extends `OrgScopedEntity` (adds an indexed `organizationId`);
  multi-tenancy is enforced **explicitly** in service code — every repository call that
  touches a tenant table takes `organizationId` from the authenticated user/token, not
  from an implicit global filter.
- Controllers return either a plain payload or `{ message, data }`; the per-controller
  `TransformInterceptor` wraps it into `{ isError: false, message, data }`. The global
  `GlobalExceptionFilter` normalizes every thrown error into `{ isError: true, message,
  data: null }`.
- `life-vault-be` (a sibling project) was used only as a scaffolding/tooling reference
  (folder shape, path aliases, bootstrap style) — no business logic, auth
  implementation, or storage/mail code was ported from it; this project's data layer
  (Postgres/TypeORM) and queue layer (BullMQ/Redis) are built fresh.
