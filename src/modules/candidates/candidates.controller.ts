import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { TransformInterceptor } from '@core/dispatchers';
import { CurrentOrgUser } from '@module/auth/decorators';
import { OrgAuthGuard } from '@module/auth/guards';
import { AuthenticatedOrgUser } from '@module/auth/types/jwt-payload.type';
import { CandidatesService } from './candidates.service';
import {
  CreateCandidateDto,
  CreateNoteDto,
  ListCandidatesQueryDto,
  UpdateCandidateDto,
  UpdateStageDto,
} from './dto';

const RESUME_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
];

const resumeUploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!RESUME_MIME_TYPES.includes(file.mimetype)) {
      cb(new BadRequestException('Only PDF and DOCX resumes are supported'), false);
      return;
    }
    cb(null, true);
  },
};

@ApiTags('Candidates')
@ApiBearerAuth()
@UseGuards(OrgAuthGuard)
@UseInterceptors(TransformInterceptor)
@Controller('candidates')
export class CandidatesController {
  constructor(private readonly candidatesService: CandidatesService) {}

  @Post()
  create(@CurrentOrgUser() user: AuthenticatedOrgUser, @Body() dto: CreateCandidateDto) {
    return this.candidatesService.create(user.organizationId, dto);
  }

  /** Parses an uploaded resume into structured fields for the Add Candidate form to
   * pre-fill, and stores the file in the resumes bucket. No candidate record is
   * written here — the returned `resumePath`/`resumeText` come back on the
   * recruiter's eventual `create()` submission, which is what attaches them. */
  @Post('parse-resume')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', resumeUploadOptions))
  parseResume(
    @CurrentOrgUser() user: AuthenticatedOrgUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No resume file was uploaded');
    return this.candidatesService.parseResume(user.organizationId, file);
  }

  @Get()
  findAll(@CurrentOrgUser() user: AuthenticatedOrgUser, @Query() query: ListCandidatesQueryDto) {
    return this.candidatesService.findAll(user.organizationId, query);
  }

  @Get(':id')
  findOne(@CurrentOrgUser() user: AuthenticatedOrgUser, @Param('id') id: string) {
    return this.candidatesService.findOne(user.organizationId, id);
  }

  /** Signed, short-lived download URL for the stored resume file. */
  @Get(':id/resume-url')
  resumeUrl(@CurrentOrgUser() user: AuthenticatedOrgUser, @Param('id') id: string) {
    return this.candidatesService.getResumeDownloadUrl(user.organizationId, id);
  }

  @Patch(':id')
  update(
    @CurrentOrgUser() user: AuthenticatedOrgUser,
    @Param('id') id: string,
    @Body() dto: UpdateCandidateDto,
  ) {
    return this.candidatesService.update(user.organizationId, id, dto);
  }

  @Patch(':id/stage')
  updateStage(
    @CurrentOrgUser() user: AuthenticatedOrgUser,
    @Param('id') id: string,
    @Body() dto: UpdateStageDto,
  ) {
    return this.candidatesService.updateStage(user.organizationId, id, dto.stage, dto.rejectReason);
  }

  @Post(':id/notes')
  addNote(
    @CurrentOrgUser() user: AuthenticatedOrgUser,
    @Param('id') id: string,
    @Body() dto: CreateNoteDto,
  ) {
    return this.candidatesService.addNote(user.organizationId, id, user.uid, dto);
  }

  @Delete(':id')
  remove(@CurrentOrgUser() user: AuthenticatedOrgUser, @Param('id') id: string) {
    return this.candidatesService.remove(user.organizationId, id);
  }
}
