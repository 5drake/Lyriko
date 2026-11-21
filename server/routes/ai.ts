import { Router } from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import type { AiConfigPublic, AiProvider, LyricLine, LyricSegment } from '../../shared/types.js';
import { redistributeSegmentTimings } from '../../shared/timing.js';
import {
  smartTranslateLyrics,
  translateLinesGoogleFree,
} from '../services/lyricTranslation.js';
import { getMediaFilePath, loadAiConfig, saveAiConfig } from '../services/storage.js';

const execFileAsync = promisify(execFile);
export const aiRouter = Router();

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function toPublicConfig(cfg: ReturnType<typeof loadAiConfig>): AiConfigPublic {
  return {
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    hasApiKey: Boolean(cfg.apiKey && cfg.apiKey.trim().length > 0),
    maskedKey: maskKey(cfg.apiKey),
  };
}

aiRouter.get('/ai/config', (_req, res) => {
  res.json(toPublicConfig(loadAiConfig()));
});

aiRouter.post('/ai/config', (req, res) => {
  const body = req.body as {
    provider?: AiProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  const updated = saveAiConfig({
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.apiKey !== undefined ? { apiKey: body.apiKey.trim() } : {}),
    ...(body.model !== undefined ? { model: body.model.trim() } : {}),
    ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl.trim() } : {}),
  });
  res.json(toPublicConfig(updated));
});

export interface AiPostProcessOptions {
  fixRuby?: boolean;
  naturalKoPron?: boolean;
  translateKo?: boolean;
  smartSegment?: boolean;
}

function buildPostProcessPrompt(
  title: string,
  artist: string,
  lines: LyricLine[],
  startIndexOffset: number,
  options: AiPostProcessOptions
): string {
  const translateOnly =
    options.translateKo !== false &&
    options.fixRuby === false &&
    options.naturalKoPron === false &&
    options.smartSegment === false;

  if (translateOnly) {
    const simpleLines = lines.map((l, idx) => ({
      index: startIndexOffset + idx,
      jpText: l.jpText,
    }));
    return [
      `당신은 일본어 J-POP 가사 한국어 번역 전문가입니다.`,
      `곡 제목: ${title || '미상'} / 아티스트: ${artist || '미상'}`,
      '',
      '다음 일본어 가사 각 줄의 시적이고 자연스러운 한국어 해석(koTranslation)만 작성하여 순수 JSON 객체로 반환하세요.',
      '',
      '반환 JSON 형식:',
      '{',
      '  "lines": [',
      '    { "index": 0, "koTranslation": "아픔의 수만큼" }',
      '  ]',
      '}',
      '',
      '입력 가사:',
      JSON.stringify(simpleLines, null, 2),
    ].join('\n');
  }

  const payloadLines = lines.map((l, idx) => ({
    index: startIndexOffset + idx,
    jpText: l.jpText,
    currentSegments: l.segments.map((s) => ({
      jp: s.jp,
      ruby: s.ruby,
      koPron: s.koPron,
    })),
    currentTranslation: l.koTranslation,
  }));

  const tasks: string[] = [];
  if (options.fixRuby !== false) {
    tasks.push(
      '1) 문맥과 가창 발음을 반영해 한자 읽기(ruby, 히라가나)를 정확히 교정하세요. 한자가 없는 순수 히라가나/카타카나/영문 청크는 ruby를 ""로 비워두세요.'
    );
  }
  if (options.naturalKoPron !== false) {
    tasks.push(
      '2) 노래방에서 따라 부르기 좋도록 자연스러운 한국어 발음(koPron)을 작성하세요. 조사 は->와, を->오, へ->에, 장음(シンゾウ->신조오), 촉음(突破->톳파), 영어 가사(예: Fly->플라이)를 반영하세요.'
    );
  }
  if (options.translateKo !== false) {
    tasks.push('3) 시적이고 자연스러운 한국어 해석(koTranslation)을 작성하세요.');
  }
  if (options.smartSegment !== false) {
    tasks.push(
      '4) segments 배열은 한 소절 내에서 숨/의미 단위(보통 2~5개 청크)로 나누고, 모든 segment.jp를 이어 붙이면 원문 jpText와 글자 누락 없이 일치하게 유지하세요.'
    );
  }

  return [
    `당신은 일본어 노래방(가라오케) 자막 및 한국어 발음·해석 전문가입니다.`,
    `곡 제목: ${title || '미상'} / 아티스트: ${artist || '미상'}`,
    '',
    '다음 일본어 가사 라인을 보정해 **순수 JSON 객체**만 출력하세요 (설명/마크다운 없이 JSON만).',
    ...tasks,
    '',
    '반환 JSON 형식:',
    '{',
    '  "lines": [',
    '    {',
    '      "index": 0,',
    '      "koTranslation": "아픔의 수만큼",',
    '      "segments": [',
    '        { "jp": "痛みの", "ruby": "いたみ", "koPron": "이타미노" },',
    '        { "jp": "数だけ", "ruby": "かず", "koPron": "카즈다케" }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '',
    '입력 가사 데이터:',
    JSON.stringify(payloadLines, null, 2),
  ].join('\n');
}

function extractJsonPayload(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    const firstArr = candidate.indexOf('[');
    const lastArr = candidate.lastIndexOf(']');
    if (firstArr !== -1 && lastArr > firstArr) {
      return JSON.parse(candidate.slice(firstArr, lastArr + 1));
    }
    throw new Error('유효한 JSON 형식을 찾을 수 없습니다.');
  }
}

interface AiReturnedLine {
  index?: number;
  jpText?: string;
  koTranslation?: string;
  segments?: Array<{ jp?: string; ruby?: string; koPron?: string }>;
}

function mergeAiOutputIntoLines(existingLines: LyricLine[], parsedJson: unknown): LyricLine[] {
  const rawArr: AiReturnedLine[] = Array.isArray(parsedJson)
    ? (parsedJson as AiReturnedLine[])
    : Array.isArray((parsedJson as { lines?: unknown })?.lines)
    ? ((parsedJson as { lines: AiReturnedLine[] }).lines)
    : [];

  if (rawArr.length === 0) {
    throw new Error('AI 응답에 lines 배열이 비어 있습니다.');
  }

  const byIndex = new Map<number, AiReturnedLine>();
  rawArr.forEach((item, pos) => {
    const idx = typeof item.index === 'number' ? item.index : pos;
    byIndex.set(idx, item);
  });

  return existingLines.map((line, idx) => {
    const patch = byIndex.get(idx);
    if (!patch) return line;

    const nextTranslation =
      typeof patch.koTranslation === 'string' && patch.koTranslation.trim().length > 0
        ? patch.koTranslation.trim()
        : line.koTranslation;

    if (!Array.isArray(patch.segments) || patch.segments.length === 0) {
      return {
        ...line,
        koTranslation: nextTranslation,
      };
    }

    const sameStructure =
      patch.segments.length === line.segments.length &&
      patch.segments.every((s, sIdx) => (s.jp ?? '').trim() === line.segments[sIdx].jp.trim());

    const mergedSegments: LyricSegment[] = patch.segments
      .filter((s) => typeof s.jp === 'string' && s.jp.length > 0)
      .map((s, sIdx) => {
        const prevSeg = line.segments[sIdx];
        return {
          id: sameStructure && prevSeg ? prevSeg.id : `seg_${Date.now().toString(36)}_${idx}_${sIdx}`,
          jp: String(s.jp),
          ruby: typeof s.ruby === 'string' ? s.ruby : '',
          koPron: typeof s.koPron === 'string' ? s.koPron : '',
          startTime: sameStructure && prevSeg ? prevSeg.startTime : line.startTime,
          endTime: sameStructure && prevSeg ? prevSeg.endTime : line.endTime,
        };
      });

    if (mergedSegments.length === 0) {
      return { ...line, koTranslation: nextTranslation };
    }

    const updatedLine: LyricLine = {
      ...line,
      koTranslation: nextTranslation,
      jpText: mergedSegments.map((s) => s.jp).join('') || line.jpText,
      segments: mergedSegments,
    };

    return sameStructure ? updatedLine : redistributeSegmentTimings(updatedLine);
  });
}

aiRouter.post('/ai/prompt', (req, res) => {
  const { title = '', artist = '', lines = [], options = {} } = req.body as {
    title?: string;
    artist?: string;
    lines?: LyricLine[];
    options?: AiPostProcessOptions;
  };
  if (!Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: '프롬프트를 생성할 가사가 없습니다.' });
    return;
  }
  const prompt = buildPostProcessPrompt(title, artist, lines, 0, options);
  res.json({ prompt });
});

aiRouter.post('/ai/apply-json', (req, res) => {
  try {
    const { lines = [], jsonText = '' } = req.body as {
      lines?: LyricLine[];
      jsonText?: string;
    };
    if (!Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: '기존 가사 라인이 없습니다.' });
      return;
    }
    const parsed = extractJsonPayload(jsonText);
    const updatedLines = mergeAiOutputIntoLines(lines, parsed);
    res.json({ lines: updatedLines });
  } catch (err) {
    res.status(400).json({
      error: `JSON 적용 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

async function callGeminiText(apiKey: string, model: string, prompt: string): Promise<string> {
  const cleanModel = model || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    cleanModel
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(90000),
  });

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini API 오류 (${response.status})`);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) {
    throw new Error('Gemini API로부터 빈 응답을 받았습니다.');
  }
  return text;
}

async function callOpenAiCompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string
): Promise<string> {
  const cleanBase = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const endpoint = `${cleanBase}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers.Authorization = 'Bearer ollama';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are a precise Japanese-to-Korean karaoke lyric processor. Reply ONLY with valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI 호환 API 오류 (${response.status})`);
  }

  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) {
    throw new Error('OpenAI 호환 API로부터 빈 응답을 받았습니다.');
  }
  return text;
}

aiRouter.post('/ai/translate-free', async (req, res) => {
  try {
    const body = req.body as { lines?: LyricLine[] };
    const lines = body.lines ?? [];
    if (!Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: '번역할 가사가 없습니다.' });
      return;
    }

    const updatedLines = await translateLinesGoogleFree(lines);
    res.json({ lines: updatedLines });
  } catch (err) {
    res.status(500).json({
      error: `자동 번역 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

aiRouter.post('/ai/translate-smart', async (req, res) => {
  try {
    const body = req.body as {
      title?: string;
      artist?: string;
      youtubeVideoId?: string;
      lines?: LyricLine[];
    };
    const lines = body.lines ?? [];
    if (!Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: '번역할 가사가 없습니다.' });
      return;
    }

    const result = await smartTranslateLyrics({
      title: String(body.title ?? ''),
      artist: String(body.artist ?? ''),
      youtubeVideoId: body.youtubeVideoId ? String(body.youtubeVideoId).trim() : undefined,
      lines,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: `신뢰 번역 탐색 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

aiRouter.post('/ai/postprocess', async (req, res) => {
  try {
    const body = req.body as {
      title?: string;
      artist?: string;
      lines?: LyricLine[];
      options?: AiPostProcessOptions;
      provider?: AiProvider;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
    };

    const lines = body.lines ?? [];
    if (!Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: '후작업할 가사가 없습니다.' });
      return;
    }

    const stored = loadAiConfig();
    const provider = body.provider ?? stored.provider;
    const apiKey = body.apiKey !== undefined && body.apiKey !== '' ? body.apiKey : stored.apiKey;
    const model = body.model || stored.model;
    const baseUrl = body.baseUrl || stored.baseUrl;

    if (provider === 'gemini' && !apiKey) {
      res.status(400).json({
        error: 'Gemini API 키가 설정되지 않았습니다. API 키를 입력하거나 아래 "프롬프트 복사" 모드를 이용하세요.',
      });
      return;
    }

    // Batch in chunks of 25 lines so output never gets truncated on long songs
    const BATCH_SIZE = 25;
    let workingLines = [...lines];

    for (let offset = 0; offset < lines.length; offset += BATCH_SIZE) {
      const slice = lines.slice(offset, offset + BATCH_SIZE);
      const prompt = buildPostProcessPrompt(
        body.title ?? '',
        body.artist ?? '',
        slice,
        offset,
        body.options ?? {}
      );

      const rawText =
        provider === 'openai'
          ? await callOpenAiCompatible(apiKey, baseUrl, model, prompt)
          : await callGeminiText(apiKey, model, prompt);

      const parsed = extractJsonPayload(rawText);
      workingLines = mergeAiOutputIntoLines(workingLines, parsed);
    }

    res.json({ lines: workingLines });
  } catch (err) {
    res.status(500).json({
      error: `AI 후작업 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

aiRouter.post('/ai/align-audio', async (req, res) => {
  const { audioFileId, lines = [], apiKey: bodyKey, model: bodyModel } = req.body as {
    audioFileId?: string;
    lines?: LyricLine[];
    apiKey?: string;
    model?: string;
  };

  if (!audioFileId) {
    res.status(400).json({ error: '먼저 음원 파일을 업로드해 주세요.' });
    return;
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: '싱크를 보정할 가사가 없습니다.' });
    return;
  }

  const stored = loadAiConfig();
  const apiKey = bodyKey || stored.apiKey;
  const model = bodyModel || stored.model || 'gemini-2.5-flash';
  if (!apiKey) {
    res.status(400).json({ error: '오디오 AI 싱크 보정은 Gemini API 키가 필요합니다.' });
    return;
  }

  const media = getMediaFilePath(audioFileId);
  if (!media) {
    res.status(404).json({ error: '업로드된 음원 파일을 찾을 수 없습니다.' });
    return;
  }
  if (!ffmpegPath) {
    res.status(500).json({ error: 'FFmpeg 실행 파일을 찾을 수 없습니다.' });
    return;
  }

  const tmpMp3 = path.join(os.tmpdir(), `utakana_align_${Date.now()}.mp3`);
  try {
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i',
      media.filePath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      tmpMp3,
    ]);

    const audioBase64 = fs.readFileSync(tmpMp3).toString('base64');
    const prompt = [
      'Listen carefully to the vocal melody in this audio file and refine the exact vocal startTime and endTime (in seconds) for each Japanese lyric line below.',
      'Return ONLY pure JSON: { "timings": [ { "index": 0, "startTime": 19.52, "endTime": 23.80 }, ... ] }',
      'Lines:',
      JSON.stringify(
        lines.map((l, idx) => ({
          index: idx,
          jpText: l.jpText,
          currentStart: l.startTime,
          currentEnd: l.endTime,
        }))
      ),
    ].join('\n');

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'audio/mp3',
                  data: audioBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(120000),
    });

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(data.error?.message || `Gemini Audio API 오류 (${response.status})`);
    }

    const rawText = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const parsed = extractJsonPayload(rawText) as {
      timings?: Array<{ index: number; startTime: number; endTime: number }>;
    };

    const timingMap = new Map<number, { startTime: number; endTime: number }>();
    for (const t of parsed.timings ?? []) {
      if (typeof t.index === 'number' && Number.isFinite(t.startTime) && Number.isFinite(t.endTime)) {
        timingMap.set(t.index, {
          startTime: Math.max(0, Number(t.startTime.toFixed(3))),
          endTime: Math.max(t.startTime + 0.3, Number(t.endTime.toFixed(3))),
        });
      }
    }

    const updatedLines = lines.map((line, idx) => {
      const t = timingMap.get(idx);
      if (!t) return line;
      return redistributeSegmentTimings({
        ...line,
        startTime: t.startTime,
        endTime: t.endTime,
      });
    });

    res.json({ lines: updatedLines });
  } catch (err) {
    res.status(500).json({
      error: `AI 오디오 싱크 보정 실패: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    if (fs.existsSync(tmpMp3)) {
      fs.unlinkSync(tmpMp3);
    }
  }
});
