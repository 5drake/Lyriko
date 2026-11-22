import { useEffect, useState } from 'react';
import {
  Check,
  Cpu,
  ExternalLink,
  HelpCircle,
  Info,
  Keyboard,
  LogOut,
  Moon,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Sun,
  Type,
  User,
  X,
} from 'lucide-react';
import {
  ADMIN_CHANGE_EVENT,
  changeAdminPassword,
  clearAdminSession,
  getCommunityDbStatus,
  getSavedContributorName,
  isAdminSessionActive,
  saveContributorName,
  verifyAdminKey,
} from '../services/communityDb';

export type UiThemeMode = 'light' | 'dark';
export type UiFontSizeMode = 'normal' | 'large' | 'xlarge';

interface SettingsModalProps {
  open: boolean;
  uiTheme: UiThemeMode;
  uiFontSize: UiFontSizeMode;
  onChangeTheme: (theme: UiThemeMode) => void;
  onChangeFontSize: (size: UiFontSizeMode) => void;
  onOpenTour: () => void;
  onOpenWorkerModal: () => void;
  onClose: () => void;
}

export function SettingsModal({
  open,
  uiTheme,
  uiFontSize,
  onChangeTheme,
  onChangeFontSize,
  onOpenTour,
  onOpenWorkerModal,
  onClose,
}: SettingsModalProps) {
  const [tab, setTab] = useState<'general' | 'credits'>('general');
  const [nickname, setNickname] = useState('');
  const [nickSaved, setNickSaved] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean>(() => isAdminSessionActive());
  const [adminKeyInput, setAdminKeyInput] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminFeedback, setAdminFeedback] = useState('');
  const [adminError, setAdminError] = useState('');
  const [showChangePw, setShowChangePw] = useState(false);
  const [newPwInput, setNewPwInput] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const isSupabaseAdmin = getCommunityDbStatus().configured;

  useEffect(() => {
    const syncAdmin = () => setIsAdmin(isAdminSessionActive());
    window.addEventListener(ADMIN_CHANGE_EVENT, syncAdmin);
    return () => window.removeEventListener(ADMIN_CHANGE_EVENT, syncAdmin);
  }, []);

  useEffect(() => {
    if (!open) return;
    setNickname(getSavedContributorName());
    setNickSaved(false);
    setIsAdmin(isAdminSessionActive());
    setAdminKeyInput('');
    setAdminFeedback('');
    setAdminError('');
    setShowChangePw(false);
    setNewPwInput('');
    setPwError('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSaveNickname = (e: React.FormEvent) => {
    e.preventDefault();
    saveContributorName(nickname);
    setNickSaved(true);
    window.setTimeout(() => setNickSaved(false), 1800);
  };

  const handleVerifyAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminKeyInput.trim() || adminBusy) return;
    setAdminBusy(true);
    setAdminError('');
    setAdminFeedback('');
    try {
      const res = await verifyAdminKey(adminKeyInput);
      if (res.ok) {
        setIsAdmin(true);
        setAdminKeyInput('');
        setAdminFeedback('관리자 인증이 완료되었습니다.');
      } else {
        setAdminError(res.error || '관리자 키가 올바르지 않습니다.');
      }
    } finally {
      setAdminBusy(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPwInput.trim() || pwBusy) return;
    setPwBusy(true);
    setPwError('');
    setAdminFeedback('');
    try {
      const res = await changeAdminPassword(newPwInput);
      if (res.ok) {
        setNewPwInput('');
        setShowChangePw(false);
        setAdminFeedback('관리자 비밀번호가 변경되었습니다.');
      } else {
        setPwError(res.error || '비밀번호 변경에 실패했습니다.');
      }
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl max-h-[86vh] flex flex-col rounded-2xl border border-white/[0.1] bg-[#0d1322] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-3.5 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 font-semibold text-slate-100 text-sm">
              <Settings className="h-4 w-4 text-sky-400" />
              <span>설정 · 정보</span>
            </div>

            <div className="inline-flex rounded-xl border border-white/[0.08] bg-black/35 p-0.5 gap-1">
              <button
                type="button"
                onClick={() => setTab('general')}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-semibold ${
                  tab === 'general'
                    ? 'border-sky-400/40 bg-sky-500/20 text-sky-200 shadow-xs'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                화면 · 일반 설정
              </button>
              <button
                type="button"
                onClick={() => setTab('credits')}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-semibold ${
                  tab === 'credits'
                    ? 'border-violet-400/40 bg-violet-500/20 text-violet-200 shadow-xs'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Info className="h-3.5 w-3.5" />
                정보 · 크레딧
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.08] hover:text-white transition"
            title="닫기 (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {tab === 'general' ? (
            <>
              {/* Theme Selection */}
              <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4 space-y-2.5">
                <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                  <Sun className="h-4 w-4 text-amber-300" />
                  화면 테마
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => onChangeTheme('light')}
                    className={`flex items-center justify-between gap-2 rounded-xl border p-3 text-left transition ${
                      uiTheme === 'light'
                        ? 'border-sky-400/50 bg-sky-500/15 ring-1 ring-sky-400/30'
                        : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.07]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Sun className="h-4 w-4 text-amber-300 shrink-0" />
                      <div>
                        <div className="font-semibold text-slate-100">밝은 테마 (기본)</div>
                        <div className="text-[10.5px] text-slate-400">
                          눈이 편안한 화이트 라이트 스튜디오
                        </div>
                      </div>
                    </div>
                    {uiTheme === 'light' && <Check className="h-4 w-4 text-sky-400 shrink-0" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => onChangeTheme('dark')}
                    className={`flex items-center justify-between gap-2 rounded-xl border p-3 text-left transition ${
                      uiTheme === 'dark'
                        ? 'border-sky-400/50 bg-sky-500/15 ring-1 ring-sky-400/30'
                        : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.07]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Moon className="h-4 w-4 text-indigo-300 shrink-0" />
                      <div>
                        <div className="font-semibold text-slate-100">다크 테마</div>
                        <div className="text-[10.5px] text-slate-400">
                          어두운 환경에 적합한 네이비 다크 모드
                        </div>
                      </div>
                    </div>
                    {uiTheme === 'dark' && <Check className="h-4 w-4 text-sky-400 shrink-0" />}
                  </button>
                </div>
              </div>

              {/* Font Size Selection */}
              <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4 space-y-3">
                <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                  <Type className="h-4 w-4 text-sky-400" />
                  글자 크기 (가독성)
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['normal', '보통', '컴팩트 표시'],
                      ['large', '크게 (기본)', '선명한 기본 크기'],
                      ['xlarge', '아주 크게', '큼직한 버튼·글씨'],
                    ] as Array<[UiFontSizeMode, string, string]>
                  ).map(([id, title, desc]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onChangeFontSize(id)}
                      className={`rounded-xl border p-2.5 text-left transition ${
                        uiFontSize === id
                          ? 'border-sky-400/50 bg-sky-500/15 ring-1 ring-sky-400/30'
                          : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.07]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-100">{title}</span>
                        {uiFontSize === id && <Check className="h-3.5 w-3.5 text-sky-400" />}
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5">{desc}</div>
                    </button>
                  ))}
                </div>

                <div className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-slate-200">
                  <span className="text-slate-400 mr-2">미리보기:</span>
                  <span className="font-semibold">ずっと傍に居たいと思った</span>
                  <span className="mx-1.5 text-slate-500">·</span>
                  <span className="text-sky-300 font-medium">즛토 소바니 이타이토 오못타</span>
                </div>
              </div>

              {/* Contributor Nickname */}
              <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4 space-y-2.5">
                <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                  <User className="h-4 w-4 text-violet-300" />
                  라이브러리 기여자 닉네임
                </div>
                <form onSubmit={handleSaveNickname} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    maxLength={32}
                    placeholder="공유 라이브러리에 수정본을 올릴 때 표시할 닉네임"
                    className="flex-1 rounded-lg border border-white/[0.09] bg-black/35 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-violet-400/60 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 rounded-lg bg-violet-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-400 transition shrink-0"
                  >
                    {nickSaved ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        저장됨
                      </>
                    ) : (
                      '저장'
                    )}
                  </button>
                </form>
              </div>

              {/* Quick Actions & Shortcuts */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4 space-y-2.5">
                  <div className="font-semibold text-slate-100">도구 바로가기</div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenTour();
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 font-medium text-slate-200 hover:bg-white/[0.1] transition"
                    >
                      <HelpCircle className="h-3.5 w-3.5 text-sky-400" />
                      튜토리얼 보기
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenWorkerModal();
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 font-medium text-slate-200 hover:bg-white/[0.1] transition"
                    >
                      <Cpu className="h-3.5 w-3.5 text-emerald-400" />
                      로컬 워커 관리
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4 space-y-2">
                  <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                    <Keyboard className="h-4 w-4 text-sky-400" />
                    키보드 단축키
                  </div>
                  <div className="space-y-1.5 text-[11px] text-slate-300">
                    <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                      <span>큰 창 곡 검색</span>
                      <kbd className="font-mono font-semibold text-sky-300">Ctrl + K</kbd>
                    </div>
                    <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                      <span>재생 / 일시정지</span>
                      <kbd className="font-mono font-semibold text-sky-300">Space / 화면 클릭</kbd>
                    </div>
                    <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                      <span>5초 / 1초 이동</span>
                      <kbd className="font-mono font-semibold text-sky-300">← → / Shift+← →</kbd>
                    </div>
                    <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                      <span>1프레임 (+소리)</span>
                      <kbd className="font-mono font-semibold text-sky-300">, . (Shift ±5F)</kbd>
                    </div>
                    <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                      <span>실행 취소 / 재실행</span>
                      <kbd className="font-mono font-semibold text-sky-300">Ctrl+Z / Ctrl+Y</kbd>
                    </div>
                    <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                      <span>현재 팝업 닫기</span>
                      <kbd className="font-mono font-semibold text-sky-300">Esc</kbd>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-3.5">
              {/* App Identity Banner */}
              <div className="rounded-xl border border-sky-400/25 bg-sky-500/[0.07] p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-100">Lyriko</h3>
                  <span className="rounded-full border border-sky-400/30 bg-sky-500/15 px-2.5 py-0.5 font-mono text-[10.5px] font-semibold text-sky-200">
                    v1.0
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  일본어 노래의 후리가나·한국어 발음(촉음 ㅅ 받침·다중독음 자동 판별)·한국어
                  번역·AI 음소 정밀 싱크·Full HD MP4 가라오케 영상을 한곳에서 만드는 스튜디오입니다.
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <a
                    href="https://5drake.github.io/Lyriko/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-sky-400/30 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/25 transition"
                  >
                    <span>웹 앱 · Live</span>
                    <ExternalLink className="h-3 w-3 opacity-70" />
                  </a>
                  <a
                    href="https://github.com/5drake/Lyriko"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-slate-100 hover:bg-white/[0.12] transition"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className="h-3.5 w-3.5 fill-current shrink-0"
                      aria-hidden="true"
                    >
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                    </svg>
                    <span>GitHub · 5drake/Lyriko</span>
                    <ExternalLink className="h-3 w-3 opacity-70" />
                  </a>
                  <a
                    href="https://github.com/5drake/Lyriko/issues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/[0.09] hover:text-white transition"
                  >
                    <span>버그 제보 · 기능 제안</span>
                    <ExternalLink className="h-3 w-3 opacity-70" />
                  </a>
                </div>
              </div>

              {/* Open Source & API Credits */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {[
                  {
                    title: 'AI 보컬 분리 · 오디오 처리',
                    items: 'BS-RoFormer (audio-separator) · FFmpeg · yt-dlp',
                  },
                  {
                    title: '음소 강제 정렬 · 다중독음 판별',
                    items: 'Meta MMS-FA (Torchaudio CTC Forced Alignment)',
                  },
                  {
                    title: '일본어 형태소 · 발음 변환',
                    items: 'Kuromoji / IPADIC · Lyriko 한국어 발음·촉음 엔진',
                  },
                  {
                    title: '가사 · 번역 · 곡 메타데이터',
                    items: 'LRCLIB · iTunes Search API · Web Translation',
                  },
                  {
                    title: '프론트엔드 · UI · 아이콘',
                    items: 'React 19 · Vite · Tailwind CSS · Lucide Icons',
                  },
                  {
                    title: '렌더링 폰트',
                    items: 'Noto Sans KR · M PLUS Rounded 1c',
                  },
                ].map((c) => (
                  <div
                    key={c.title}
                    className="rounded-xl border border-white/[0.08] bg-black/25 p-3 space-y-1"
                  >
                    <div className="font-semibold text-slate-100">{c.title}</div>
                    <div className="text-[11px] text-slate-400 leading-relaxed">{c.items}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3.5 text-[11px] text-slate-400 leading-relaxed">
                음원 파일은 사용자의 로컬 PC에서만 처리·인코딩되며 공유 서버에 업로드되지
                않습니다. 공용 라이브러리에는 가사·싱크·독음·번역 데이터만 저장됩니다.
              </div>

              {/* Operator / Admin Auth Card */}
              <div className="rounded-xl border border-white/[0.08] bg-black/25 p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                    {isAdmin ? (
                      <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <Shield className="h-4 w-4 text-slate-400" />
                    )}
                    <span>운영자(관리자) 인증</span>
                  </div>
                  {isAdmin && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/35 bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-200">
                      관리자 모드 활성화됨
                    </span>
                  )}
                </div>

                {isAdmin ? (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300">
                      <span>현재 브라우저 세션에서 라이브러리 검수·잠금·버전 복구·삭제 도구를 사용할 수 있습니다.</span>
                      <div className="flex items-center gap-1.5">
                        {isSupabaseAdmin && (
                          <button
                            type="button"
                            onClick={() => {
                              setShowChangePw((prev) => !prev);
                              setPwError('');
                              setNewPwInput('');
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-sky-400/30 bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/25 transition"
                          >
                            비밀번호 변경
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            clearAdminSession();
                            setIsAdmin(false);
                            setShowChangePw(false);
                            setAdminFeedback('');
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.1] transition"
                        >
                          <LogOut className="h-3.5 w-3.5" />
                          로그아웃
                        </button>
                      </div>
                    </div>
                    {adminFeedback && (
                      <div className="text-[11px] text-emerald-300 font-medium">{adminFeedback}</div>
                    )}
                    {showChangePw && isSupabaseAdmin && (
                      <form onSubmit={handleChangePassword} className="space-y-1.5 pt-1">
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            value={newPwInput}
                            onChange={(e) => {
                              setNewPwInput(e.target.value);
                              setPwError('');
                            }}
                            placeholder="새 비밀번호 (4자 이상)"
                            className="flex-1 rounded-lg border border-white/[0.09] bg-black/35 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                          />
                          <button
                            type="submit"
                            disabled={pwBusy || newPwInput.trim().length < 4}
                            className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-45 transition shrink-0"
                          >
                            {pwBusy ? '변경 중...' : '변경'}
                          </button>
                        </div>
                        {pwError && (
                          <div className="text-[11px] text-rose-300 font-medium">{pwError}</div>
                        )}
                      </form>
                    )}
                  </div>
                ) : (
                  <form onSubmit={handleVerifyAdmin} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={adminKeyInput}
                        onChange={(e) => {
                          setAdminKeyInput(e.target.value);
                          setAdminError('');
                        }}
                        placeholder="관리자 키 입력"
                        className="flex-1 rounded-lg border border-white/[0.09] bg-black/35 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={adminBusy || !adminKeyInput.trim()}
                        className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-45 transition shrink-0"
                      >
                        {adminBusy ? '확인 중...' : '인증'}
                      </button>
                    </div>
                    {adminError && (
                      <div className="text-[11px] text-rose-300 font-medium">{adminError}</div>
                    )}
                    {adminFeedback && (
                      <div className="text-[11px] text-emerald-300 font-medium">{adminFeedback}</div>
                    )}
                    <div className="text-[10.5px] text-slate-400">
                      {isSupabaseAdmin ? (
                        'Supabase 공용 DB 관리자 비밀번호로 인증합니다. 로컬 워커 없이 어느 브라우저에서나 공용 라이브러리 검수·잠금·버전 복구·삭제를 할 수 있습니다.'
                      ) : (
                        <>
                          관리자 키는 서버 <code className="font-mono">LYRIKO_ADMIN_KEY</code> 환경변수 또는{' '}
                          <code className="font-mono">server/data/admin_key.txt</code>에서 확인합니다.
                        </>
                      )}
                    </div>
                  </form>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
