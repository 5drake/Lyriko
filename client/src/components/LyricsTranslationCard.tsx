import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Languages,
  Loader2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  AiConfigPublic,
  AiProvider,
  KaraokeProject,
  SmartTranslateResult,
  TranslationCandidate,
  TranslationSourceType,
} from '@shared/types';
import {
  applyAiJsonResponse,
  getAiConfig,
  runAiPostProcess,
  saveAiConfig,
  translateLyricsFree,
  translateLyricsSmart,
} from '../api';

type TranslateMode = 'smart' | 'paste' | 'api';

function sourceTypeBadge(type: TranslationSourceType): { label: string; cls: string } {
  if (type === 'youtube-cc') {
    return {
      label: 'YouTube 공식 자막',
      cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    };
  }
  if (type === 'web-parallel') {
    return {
      label: '웹 신뢰 번역',
      cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    };
  }
  return {
    label: '자동 번역 (폴백)',
    cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  };
}

interface LyricsTranslationCardProps {
  project: KaraokeProject;
  onUpdateProject: (updater: (prev: KaraokeProject) => KaraokeProject) => void;
}

export function LyricsTranslationCard({
  project,
  onUpdateProject,
}: LyricsTranslationCardProps) {
  const [mode, setMode] = useState<TranslateMode>('smart');
  const [busy, setBusy] = useState(false);
  const [busyKind, setBusyKind] = useState<'smart' | 'free' | 'other'>('other');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [lastResult, setLastResult] = useState<SmartTranslateResult | null>(null);

  // Paste mode states
  const [copiedSource, setCopiedSource] = useState(false);
  const [pastedText, setPastedText] = useState('');

  // API mode states
  const [config, setConfig] = useState<AiConfigPublic | null>(null);
  const [provider, setProvider] = useState<AiProvider>('gemini');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [model, setModel] = useState('gemini-2.5-flash');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');

  useEffect(() => {
    setLastResult(null);
    setStatusMsg('');
    setErrorMsg('');
  }, [project.id]);

  useEffect(() => {
    getAiConfig()
      .then((cfg) => {
        setConfig(cfg);
        setProvider(cfg.provider);
        setModel(cfg.model);
        setBaseUrl(cfg.baseUrl);
      })
      .catch(() => {});
  }, []);

  const totalCount = project.lines.length;
  const translatedCount = useMemo(
    () =>
      project.lines.filter((l) => Boolean(l.koTranslation && l.koTranslation.trim())).length,
    [project.lines]
  );

  const badgeCls =
    totalCount === 0 || translatedCount === 0
      ? 'bg-white/[0.04] text-slate-400 border-white/[0.08]'
      : translatedCount >= totalCount
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-400/25'
      : 'bg-amber-500/15 text-amber-300 border-amber-400/25';

  const handleSmartTranslate = async () => {
    if (project.lines.length === 0) {
      setErrorMsg('먼저 위 [가사] 카드에서 일본어 가사를 불러오세요.');
      return;
    }
    setBusy(true);
    setBusyKind('smart');
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res = await translateLyricsSmart({
        title: project.title,
        artist: project.artist,
        youtubeVideoId: project.youtubeVideoId,
        lines: project.lines,
      });
      onUpdateProject((prev) => ({
        ...prev,
        lines: res.lines,
        settings: { ...prev.settings, showTranslation: true },
      }));
      setLastResult(res);
      if (res.sourceType === 'machine-fallback') {
        setStatusMsg(
          `웹 신뢰 번역을 찾지 못해 자동 번역으로 ${res.fallbackFilled}/${res.totalLines}줄 채웠습니다.`
        );
      } else if (res.fallbackFilled > 0) {
        setStatusMsg(
          `${res.sourceLabel}에서 ${res.matchedFromWeb}/${res.totalLines}줄 반영 (+${res.fallbackFilled}줄 자동 보완)`
        );
      } else {
        setStatusMsg(
          `${res.sourceLabel} 번역 적용 완료 (${res.matchedFromWeb}/${res.totalLines}줄)`
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyKind('other');
    }
  };

  const handleApplyCandidate = (cand: TranslationCandidate) => {
    onUpdateProject((prev) => ({
      ...prev,
      lines: prev.lines.map((line, i) => ({
        ...line,
        koTranslation: cand.translations[i] || line.koTranslation || '',
      })),
      settings: { ...prev.settings, showTranslation: true },
    }));
    setLastResult((prev) =>
      prev
        ? {
            ...prev,
            sourceType: cand.sourceType,
            sourceLabel: cand.sourceLabel,
            sourceUrl: cand.sourceUrl,
            matchedFromWeb: cand.matchedCount,
            fallbackFilled: 0,
          }
        : null
    );
    setStatusMsg(`${cand.sourceLabel} 후보 번역으로 전환 (${cand.matchedCount}/${cand.totalCount}줄)`);
  };

  const handleFreeTranslate = async () => {
    if (project.lines.length === 0) {
      setErrorMsg('먼저 위 [가사] 카드에서 일본어 가사를 불러오세요.');
      return;
    }
    setBusy(true);
    setBusyKind('free');
    setErrorMsg('');
    setStatusMsg('');
    try {
      const updated = await translateLyricsFree(project.lines);
      onUpdateProject((prev) => ({
        ...prev,
        lines: updated,
        settings: { ...prev.settings, showTranslation: true },
      }));
      setLastResult(null);
      const count = updated.filter((l) => l.koTranslation.trim()).length;
      setStatusMsg(`한국어 자동 번역 덮어쓰기 완료 (${count}/${updated.length}줄 적용)`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyKind('other');
    }
  };

  const handleCopySourceLines = async () => {
    if (project.lines.length === 0) return;
    const header =
      `아래 일본어 노래 가사 ${project.lines.length}줄을 같은 번호 순서대로 자연스러운 한국어로 번역해 주세요 (${project.title || '미상'}):\n\n`;
    const body = project.lines.map((l, idx) => `${idx + 1}. ${l.jpText}`).join('\n');
    await navigator.clipboard.writeText(header + body);
    setCopiedSource(true);
    setTimeout(() => setCopiedSource(false), 1800);
  };

  const handleApplyPastedTranslation = async () => {
    const raw = pastedText.trim();
    if (!raw || project.lines.length === 0) return;
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      if (raw.startsWith('{') || raw.startsWith('[') || raw.includes('"koTranslation"')) {
        const updated = await applyAiJsonResponse(project.lines, raw);
        onUpdateProject((prev) => ({
          ...prev,
          lines: updated,
          settings: { ...prev.settings, showTranslation: true },
        }));
        setStatusMsg('JSON 번역 결과를 가사에 적용했습니다.');
      } else {
        const parsedLines = raw
          .split(/\r?\n/)
          .map((line) =>
            line
              .replace(/^(?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*)+/, '')
              .replace(/^\s*(?:#?\d+[.)\]:·]\s*)/, '')
              .trim()
          )
          .filter((line) => line.length > 0);

        if (parsedLines.length === 0) {
          throw new Error('적용할 한국어 번역 줄을 찾지 못했습니다.');
        }

        onUpdateProject((prev) => ({
          ...prev,
          lines: prev.lines.map((line, i) =>
            i < parsedLines.length
              ? { ...line, koTranslation: parsedLines[i] }
              : line
          ),
          settings: { ...prev.settings, showTranslation: true },
        }));
        const applied = Math.min(project.lines.length, parsedLines.length);
        setStatusMsg(`붙여넣은 한국어 번역 ${applied}/${project.lines.length}줄 적용 완료!`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveConfig = async () => {
    setErrorMsg('');
    try {
      const updated = await saveAiConfig({
        provider,
        ...(apiKeyInput ? { apiKey: apiKeyInput } : {}),
        model,
        baseUrl,
      });
      setConfig(updated);
      setApiKeyInput('');
      setStatusMsg('AI API 설정 저장됨');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleApiTranslate = async () => {
    if (project.lines.length === 0) {
      setErrorMsg('먼저 위 [가사] 카드에서 일본어 가사를 불러오세요.');
      return;
    }
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      if (apiKeyInput) {
        const saved = await saveAiConfig({ provider, apiKey: apiKeyInput, model, baseUrl });
        setConfig(saved);
        setApiKeyInput('');
      }
      const updated = await runAiPostProcess({
        title: project.title,
        artist: project.artist,
        lines: project.lines,
        options: {
          fixRuby: false,
          naturalKoPron: false,
          translateKo: true,
          smartSegment: false,
        },
        provider,
        ...(apiKeyInput ? { apiKey: apiKeyInput } : {}),
        model,
        baseUrl,
      });
      onUpdateProject((prev) => ({
        ...prev,
        lines: updated,
        settings: { ...prev.settings, showTranslation: true },
      }));
      setStatusMsg(`AI 시적 번역 완료 (${updated.length}줄 반영)`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3.5 space-y-2.5">
      {/* Header */}
      <div className="flex items-center justify-between gap-1.5">
        <div className="font-semibold text-slate-100 flex items-center gap-1.5 min-w-0">
          <Languages className="h-4 w-4 text-sky-400 shrink-0" />
          <span className="truncate">한국어 번역</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`rounded border px-1.5 py-0.5 font-mono tabular-nums text-[10px] ${badgeCls}`}>
            {translatedCount}/{totalCount}
          </span>
          <button
            type="button"
            onClick={() =>
              onUpdateProject((p) => ({
                ...p,
                settings: { ...p.settings, showTranslation: !p.settings.showTranslation },
              }))
            }
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold border transition ${
              project.settings.showTranslation
                ? 'border-sky-400/35 bg-sky-500/15 text-sky-200'
                : 'border-white/[0.08] bg-black/30 text-slate-400 hover:text-slate-200'
            }`}
            title="가라오케 영상 화면에 한국어 해석 표시 여부"
          >
            {project.settings.showTranslation ? (
              <>
                <Eye className="h-3 w-3" />
                표시
              </>
            ) : (
              <>
                <EyeOff className="h-3 w-3" />
                숨김
              </>
            )}
          </button>
        </div>
      </div>

      {/* 3 Mode Pills */}
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/35 p-0.5 border border-white/[0.06]">
        {(
          [
            ['smart', '신뢰 번역'],
            ['paste', '직접 붙여넣기'],
            ['api', 'AI API'],
          ] as Array<[TranslateMode, string]>
        ).map(([val, label]) => (
          <button
            key={val}
            type="button"
            disabled={busy}
            onClick={() => {
              setMode(val);
              setErrorMsg('');
            }}
            className={`rounded-md py-1 text-[10.5px] font-semibold transition ${
              mode === val
                ? 'bg-white/[0.11] text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'smart' && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => void handleSmartTranslate()}
            disabled={busy || project.lines.length === 0}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.08] py-2 text-[11px] font-semibold text-white hover:bg-white/[0.14] disabled:opacity-40 transition"
          >
            {busy && busyKind === 'smart' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Globe className="h-3.5 w-3.5 text-sky-400" />
            )}
            {busy && busyKind === 'smart'
              ? '신뢰 번역 찾는 중...'
              : '웹 신뢰 번역 가져오기'}
          </button>

          {project.lines.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-slate-500 truncate">
                공식 자막·웹 번역 우선 적용
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleFreeTranslate()}
                  className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-black/30 px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-40 transition"
                  title="웹 탐색 없이 무료 기계번역으로 모든 줄을 덮어씁니다"
                >
                  {busy && busyKind === 'free' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Languages className="h-3 w-3" />
                  )}
                  자동 번역
                </button>

                {translatedCount > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onUpdateProject((prev) => ({
                        ...prev,
                        lines: prev.lines.map((l) => ({ ...l, koTranslation: '' })),
                      }));
                      setLastResult(null);
                      setStatusMsg('한국어 번역을 비웠습니다.');
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-black/30 px-2 py-1 text-[10px] text-slate-400 hover:text-rose-400 disabled:opacity-40 transition"
                    title="번역 텍스트만 모두 지웁니다"
                  >
                    <Trash2 className="h-3 w-3" />
                    비우기
                  </button>
                )}
              </div>
            </div>
          )}

          {lastResult && (
            <div className="rounded-lg border border-white/[0.08] bg-black/30 p-2 space-y-1.5 text-[10px]">
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 font-semibold ${
                      sourceTypeBadge(lastResult.sourceType).cls
                    }`}
                  >
                    {sourceTypeBadge(lastResult.sourceType).label}
                  </span>
                  <span className="truncate text-slate-200 font-medium" title={lastResult.sourceLabel}>
                    {lastResult.sourceLabel}
                  </span>
                </div>
                {lastResult.sourceUrl && (
                  <a
                    href={lastResult.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 inline-flex items-center gap-0.5 text-sky-400 hover:text-sky-300"
                    title="번역 원문 페이지 열기"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>

              <div className="text-slate-400 tabular-nums">
                {lastResult.sourceType === 'machine-fallback'
                  ? `자동 번역 ${lastResult.fallbackFilled}/${lastResult.totalLines}줄`
                  : lastResult.fallbackFilled > 0
                  ? `${lastResult.matchedFromWeb}/${lastResult.totalLines}줄 + ${lastResult.fallbackFilled}줄 자동 보완`
                  : `${lastResult.matchedFromWeb}/${lastResult.totalLines}줄`}
              </div>

              {lastResult.candidates.length > 1 && (
                <div className="pt-1.5 border-t border-white/[0.06] space-y-1">
                  <div className="text-slate-500 font-medium">다른 번역 후보</div>
                  <div className="flex flex-wrap gap-1">
                    {lastResult.candidates.map((cand) => {
                      const active = cand.sourceUrl === lastResult.sourceUrl;
                      return (
                        <button
                          key={cand.sourceUrl}
                          type="button"
                          onClick={() => handleApplyCandidate(cand)}
                          className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                            active
                              ? 'border-sky-400/50 bg-sky-500/15 text-sky-200 font-semibold'
                              : 'border-white/[0.08] bg-black/35 text-slate-300 hover:border-white/[0.18] hover:text-white'
                          }`}
                        >
                          {cand.sourceLabel} ({cand.matchedCount}/{cand.totalCount})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'paste' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-1.5">
            <span className="text-[10.5px] text-slate-400">
              번역문 줄별 붙여넣기
            </span>
            <button
              type="button"
              disabled={project.lines.length === 0}
              onClick={() => void handleCopySourceLines()}
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-black/30 px-2 py-0.5 text-[10px] font-semibold text-sky-300 hover:bg-white/[0.08] disabled:opacity-40 transition"
            >
              {copiedSource ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copiedSource ? '복사됨!' : '원문 복사'}
            </button>
          </div>

          <textarea
            rows={4}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder={`1. 아픔의 수만큼\n2. 그것은 나의 정맥을 지나`}
            className="w-full rounded-lg border border-white/[0.08] bg-black/35 p-2 text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
          />

          <button
            type="button"
            disabled={busy || !pastedText.trim() || project.lines.length === 0}
            onClick={() => void handleApplyPastedTranslation()}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.08] py-2 text-[11px] font-semibold text-white hover:bg-white/[0.14] disabled:opacity-40 transition"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ClipboardPaste className="h-3.5 w-3.5 text-sky-400" />
            )}
            줄 맞춰 번역 적용
          </button>
        </div>
      )}

      {mode === 'api' && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/35 p-0.5 border border-white/[0.06]">
            {(
              [
                ['gemini', 'Gemini API'],
                ['openai', 'OpenAI / 로컬'],
              ] as Array<[AiProvider, string]>
            ).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => setProvider(val)}
                className={`rounded-md py-1 text-[10.5px] font-semibold transition ${
                  provider === val
                    ? 'bg-white/[0.11] text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1 text-[10px] text-slate-400">
              <KeyRound className="h-3 w-3 text-sky-400" />
              <span>
                API 키 {config?.hasApiKey ? `(저장됨: ${config.maskedKey})` : '(Ollama 로컬은 생략)'}
              </span>
            </div>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={config?.hasApiKey ? '새 키 입력 시 덮어쓰기' : 'AIza... 또는 sk-...'}
              className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-2.5 py-1.5 text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
            />
            {provider === 'openai' && (
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="w-full rounded-lg border border-white/[0.08] bg-black/35 px-2.5 py-1.5 text-[11px] text-slate-100 focus:border-sky-400/60 focus:outline-none"
              />
            )}
            <div className="flex gap-1.5">
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gemini-2.5-flash"
                className="flex-1 min-w-0 rounded-lg border border-white/[0.08] bg-black/35 px-2.5 py-1.5 text-[11px] text-slate-100 focus:border-sky-400/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleSaveConfig()}
                className="shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.05] px-2.5 py-1.5 text-[10.5px] font-medium text-slate-200 hover:bg-white/[0.1] transition"
              >
                저장
              </button>
            </div>
          </div>

          <button
            type="button"
            disabled={busy || project.lines.length === 0}
            onClick={() => void handleApiTranslate()}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-sky-500 py-2 text-[11px] font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40 transition"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            AI 시적 번역 실행
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-2 text-[11px] text-rose-200">
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="flex items-start gap-1.5 rounded-lg border border-emerald-400/25 bg-emerald-500/10 p-2 text-[11px] text-emerald-200">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
          <span>{statusMsg}</span>
        </div>
      )}
    </section>
  );
}
