import { computeAnswerSpeechMetrics, computeSpeechMetrics, countWords } from './speech-metrics';

const seg = (start: number, end: number) => ({ start, end, text: 'x' });

describe('speech metrics', () => {
  it('measures pace, talk time, long pauses and response delay for one answer', () => {
    const m = computeAnswerSpeechMetrics({
      questionId: 'q1',
      // 30 words over 15s of speech → 120 wpm
      transcriptText: Array.from({ length: 30 }, () => 'word').join(' '),
      segments: [seg(1.5, 6.5), seg(7, 12), seg(15, 20)], // gaps 0.5s and 3s
      recordingSeconds: 20,
    });
    expect(m).toEqual({
      wordCount: 30,
      speakingSeconds: 15,
      recordingSeconds: 20,
      wordsPerMinute: 120,
      talkRatio: 0.75,
      longPauses: 1,
      responseDelaySeconds: 1.5,
    });
  });

  it('handles an answer with no speech', () => {
    const m = computeAnswerSpeechMetrics({
      questionId: 'q1',
      transcriptText: '',
      segments: [],
      recordingSeconds: 9,
    });
    expect(m).toMatchObject({
      wordCount: 0,
      speakingSeconds: 0,
      wordsPerMinute: null,
      talkRatio: 0,
      longPauses: 0,
      responseDelaySeconds: null,
    });
  });

  it('ignores malformed segments and does not report a pace for very short speech', () => {
    const m = computeAnswerSpeechMetrics({
      questionId: 'q1',
      transcriptText: 'yes',
      segments: [seg(2, 1), seg(0.5, 1.5)],
      recordingSeconds: null,
    });
    expect(m.speakingSeconds).toBe(1);
    expect(m.wordsPerMinute).toBeNull();
    expect(m.talkRatio).toBeNull();
  });

  it('aggregates across answers, averaging the response delay over answered questions', () => {
    const result = computeSpeechMetrics([
      {
        questionId: 'q1',
        transcriptText: Array.from({ length: 20 }, () => 'w').join(' '),
        segments: [seg(1, 6), seg(9, 14)],
        recordingSeconds: 15,
      },
      { questionId: 'q2', transcriptText: '', segments: [], recordingSeconds: 5 },
      {
        questionId: 'q3',
        transcriptText: Array.from({ length: 20 }, () => 'w').join(' '),
        segments: [seg(3, 13)],
        recordingSeconds: 15,
      },
    ]);
    expect(Object.keys(result.perQuestion)).toEqual(['q1', 'q2', 'q3']);
    expect(result.overall).toEqual({
      wordCount: 40,
      speakingSeconds: 20,
      recordingSeconds: 35,
      wordsPerMinute: 120,
      talkRatio: 0.57,
      longPauses: 1,
      responseDelaySeconds: 2,
    });
  });

  it('counts words on any whitespace', () => {
    expect(countWords('  hello   world\nagain ')).toBe(3);
    expect(countWords(null)).toBe(0);
  });
});
