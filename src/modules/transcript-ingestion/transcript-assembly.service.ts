import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { TranscriptionClientService } from '@core/transcription';
import { AnswerTranscriptionStatus, InterviewAnswer } from '@module/interview-session/entities';
import { Interview } from '@module/interviews/entities';
import { InterviewTranscript } from './entities';
import { EvaluationProcessingProducerService } from './producers/evaluation-processing.producer';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Turns per-answer transcripts into the interview-level `interview_transcripts` row
 * the evaluation reads, once every answer has a final transcription result, then
 * hands off to `evaluation-processing`. Idempotent: returns early while anything is
 * pending or once the row exists (a concurrent insert losing the unique race too).
 */
@Injectable()
export class TranscriptAssemblyService {
  private readonly logger = new Logger(TranscriptAssemblyService.name);

  constructor(
    @InjectRepository(Interview)
    private readonly interviewsRepository: Repository<Interview>,
    @InjectRepository(InterviewAnswer)
    private readonly answersRepository: Repository<InterviewAnswer>,
    @InjectRepository(InterviewTranscript)
    private readonly transcriptsRepository: Repository<InterviewTranscript>,
    private readonly transcriptionClient: TranscriptionClientService,
    private readonly evaluationProcessingProducer: EvaluationProcessingProducerService,
  ) {}

  async finalizeInterviewTranscript(interviewId: string): Promise<void> {
    const answers = await this.answersRepository.find({
      where: { interviewId, transcriptionStatus: Not(IsNull()) },
    });
    if (answers.length === 0) return;
    if (answers.some((a) => a.transcriptionStatus === AnswerTranscriptionStatus.PENDING)) return;
    if (await this.transcriptsRepository.findOne({ where: { interviewId } })) return;

    const interview = await this.interviewsRepository.findOne({
      where: { id: interviewId },
      relations: { questions: true },
    });
    if (!interview) return;

    const orderOf = new Map((interview.questions ?? []).map((q) => [q.id, q.orderIndex]));
    const completed = answers
      .filter((a) => a.transcriptionStatus === AnswerTranscriptionStatus.COMPLETED)
      .sort(
        (a, b) =>
          (orderOf.get(a.interviewQuestionId) ?? 0) - (orderOf.get(b.interviewQuestionId) ?? 0),
      );

    try {
      if (completed.length === 0) {
        const reason =
          answers.map((a) => a.transcriptionError).find(Boolean) ?? 'Transcription failed';
        await this.transcriptsRepository.insert({
          interviewId,
          organizationId: interview.organizationId,
          combinedText: '',
          perQuestion: [],
          failureReason: reason,
        });
        this.logger.error(
          `Transcription failed for every answer of interview ${interviewId}: ${reason}`,
        );
        return;
      }

      await this.transcriptsRepository.insert({
        interviewId,
        organizationId: interview.organizationId,
        combinedText: completed
          .map((a) => a.transcriptText?.trim() ?? '')
          .filter(Boolean)
          .join('\n\n'),
        perQuestion: completed.map((a) => ({
          questionId: a.interviewQuestionId,
          transcriptText: a.transcriptText ?? '',
        })),
        language: this.transcriptionClient.language ?? null,
      });
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) return; // lost the race — already done
      throw err;
    }
    this.logger.log(
      `Persisted transcript for interview ${interviewId} (${completed.length}/${answers.length} answers)`,
    );

    await this.evaluationProcessingProducer.enqueue({
      interviewId,
      candidateId: interview.candidateId,
      organizationId: interview.organizationId,
    });
  }
}
