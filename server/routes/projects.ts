import { Router } from 'express';
import {
  DEFAULT_RENDER_SETTINGS,
  type KaraokeProject,
} from '../../shared/types.js';
import { redistributeSegmentTimings } from '../../shared/timing.js';
import {
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
} from '../services/storage.js';

export const projectsRouter = Router();

function buildDemoProject(): KaraokeProject {
  const rawLines = [
    {
      id: 'demo_1',
      startTime: 6.0,
      endTime: 9.8,
      jpText: '痛みの数だけ',
      koTranslation: '아픔의 수만큼',
      segments: [
        { id: 'd1_1', jp: '痛みの', ruby: 'いたみ', koPron: '이타미노', startTime: 6.0, endTime: 8.0 },
        { id: 'd1_2', jp: '数だけ', ruby: 'かず', koPron: '카즈다케', startTime: 8.0, endTime: 9.8 },
      ],
    },
    {
      id: 'demo_2',
      startTime: 10.2,
      endTime: 14.5,
      jpText: 'それは、僕の静脈を通り',
      koTranslation: '그것은 나의 정맥을 지나',
      segments: [
        { id: 'd2_1', jp: 'それは、', ruby: '', koPron: '소레와', startTime: 10.2, endTime: 11.4 },
        { id: 'd2_2', jp: '僕の', ruby: 'ぼく', koPron: '보쿠노', startTime: 11.4, endTime: 12.3 },
        { id: 'd2_3', jp: '静脈を', ruby: 'じょうみゃく', koPron: '죠오먀쿠오', startTime: 12.3, endTime: 13.5 },
        { id: 'd2_4', jp: '通り', ruby: 'とお', koPron: '토오리', startTime: 13.5, endTime: 14.5 },
      ],
    },
    {
      id: 'demo_3',
      startTime: 15.0,
      endTime: 19.2,
      jpText: '心臓を突破して',
      koTranslation: '심장을 돌파해서',
      segments: [
        { id: 'd3_1', jp: '心臓を', ruby: 'しんぞう', koPron: '신조오오', startTime: 15.0, endTime: 16.9 },
        { id: 'd3_2', jp: '突破して', ruby: 'とっぱ', koPron: '톳파시테', startTime: 16.9, endTime: 19.2 },
      ],
    },
    {
      id: 'demo_4',
      startTime: 24.5,
      endTime: 28.4,
      jpText: 'この小さな うらみわびの',
      koTranslation: '이 자그마한 원망과 후회의',
      segments: [
        { id: 'd4_1', jp: 'この', ruby: '', koPron: '코노', startTime: 24.5, endTime: 25.3 },
        { id: 'd4_2', jp: '小さな', ruby: 'ちい', koPron: '치이사나', startTime: 25.3, endTime: 26.6 },
        { id: 'd4_3', jp: 'うらみわびの', ruby: '', koPron: '우라미와비노', startTime: 26.6, endTime: 28.4 },
      ],
    },
    {
      id: 'demo_5',
      startTime: 28.6,
      endTime: 32.8,
      jpText: '隙間風は 許してくれ',
      koTranslation: '틈새 바람은 용서해 줘',
      segments: [
        { id: 'd5_1', jp: '隙間風は', ruby: 'すきまかぜ', koPron: '스키마카제와', startTime: 28.6, endTime: 30.6 },
        { id: 'd5_2', jp: '許してくれ', ruby: 'ゆる', koPron: '유루시테쿠레', startTime: 30.6, endTime: 32.8 },
      ],
    },
    {
      id: 'demo_6',
      startTime: 33.0,
      endTime: 37.2,
      jpText: '僕の言葉も涙も全部',
      koTranslation: '내 말도 눈물도 전부',
      segments: [
        { id: 'd6_1', jp: '僕の', ruby: 'ぼく', koPron: '보쿠노', startTime: 33.0, endTime: 33.9 },
        { id: 'd6_2', jp: '言葉も', ruby: 'ことば', koPron: '코토바모', startTime: 33.9, endTime: 35.0 },
        { id: 'd6_3', jp: '涙も', ruby: 'なみだ', koPron: '나미다모', startTime: 35.0, endTime: 36.1 },
        { id: 'd6_4', jp: '全部', ruby: 'ぜんぶ', koPron: '젠부', startTime: 36.1, endTime: 37.2 },
      ],
    },
  ].map((l) => redistributeSegmentTimings(l));

  return {
    id: 'demo_tobu_toki',
    title: '飛ぶ時',
    artist: 'Vaundy',
    subtitle: '',
    credits: '',
    duration: 42,
    audioMode: 'karaoke',
    keyShift: 0,
    guideVocalVolume: 0.28,
    guideMelodyVolume: 0.75,
    syncOffset: 0,
    mrSyncOffset: 0,
    karaokeSyncOffset: 0,
    lines: rawLines,
    pitchNotes: [],
    settings: { ...DEFAULT_RENDER_SETTINGS },
    updatedAt: new Date().toISOString(),
  };
}

projectsRouter.get('/demo', (_req, res) => {
  res.json(buildDemoProject());
});

projectsRouter.get('/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

projectsRouter.get('/projects/:id', (req, res) => {
  const proj = loadProject(req.params.id);
  if (!proj) {
    res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
    return;
  }
  res.json(proj);
});

projectsRouter.post('/projects', (req, res) => {
  const proj = req.body as KaraokeProject;
  if (!proj || !proj.title) {
    res.status(400).json({ error: '잘못된 프로젝트 데이터입니다.' });
    return;
  }
  const saved = saveProject(proj);
  res.json(saved);
});

projectsRouter.delete('/projects/:id', (req, res) => {
  const ok = deleteProject(req.params.id);
  res.json({ ok });
});
