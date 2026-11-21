import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiProvider, KaraokeProject } from '../../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..', '..');
const envDataDir = process.env.LYRIKO_DATA_DIR || process.env.UTAKANA_DATA_DIR;
export const DATA_DIR = envDataDir
  ? path.resolve(envDataDir)
  : path.join(ROOT_DIR, 'server', 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, UPLOADS_DIR, PROJECTS_DIR, EXPORTS_DIR, CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export interface StoredMediaMeta {
  id: string;
  kind: 'audio' | 'background';
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export function saveMediaMeta(meta: StoredMediaMeta): void {
  ensureDataDirs();
  fs.writeFileSync(
    path.join(UPLOADS_DIR, `${meta.id}.json`),
    JSON.stringify(meta, null, 2),
    'utf-8'
  );
}

export function getMediaMeta(id: string): StoredMediaMeta | null {
  const safeId = path.basename(id);
  const metaPath = path.join(UPLOADS_DIR, `${safeId}.json`);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as StoredMediaMeta;
  } catch {
    return null;
  }
}

export function getMediaFilePath(id: string): { meta: StoredMediaMeta; filePath: string } | null {
  const meta = getMediaMeta(id);
  if (!meta) return null;
  const filePath = path.join(UPLOADS_DIR, meta.storedName);
  if (!fs.existsSync(filePath)) return null;
  return { meta, filePath };
}

export interface StoredAiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

const DEFAULT_AI_CONFIG: StoredAiConfig = {
  provider: 'gemini',
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  model: 'gemini-2.5-flash',
  baseUrl: 'https://api.openai.com/v1',
};

export function loadAiConfig(): StoredAiConfig {
  ensureDataDirs();
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_AI_CONFIG };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<StoredAiConfig>;
    return {
      provider: parsed.provider ?? DEFAULT_AI_CONFIG.provider,
      apiKey: parsed.apiKey ?? DEFAULT_AI_CONFIG.apiKey,
      model: parsed.model ?? DEFAULT_AI_CONFIG.model,
      baseUrl: parsed.baseUrl ?? DEFAULT_AI_CONFIG.baseUrl,
    };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

export function saveAiConfig(next: Partial<StoredAiConfig>): StoredAiConfig {
  const current = loadAiConfig();
  const merged: StoredAiConfig = {
    provider: next.provider ?? current.provider,
    apiKey: next.apiKey !== undefined ? next.apiKey : current.apiKey,
    model: next.model ?? current.model,
    baseUrl: next.baseUrl ?? current.baseUrl,
  };
  ensureDataDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

export function listProjects(): Pick<KaraokeProject, 'id' | 'title' | 'artist' | 'updatedAt' | 'duration'>[] {
  ensureDataDirs();
  const files = fs.readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.json'));
  const summaries: Pick<KaraokeProject, 'id' | 'title' | 'artist' | 'updatedAt' | 'duration'>[] = [];
  for (const file of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, file), 'utf-8')) as KaraokeProject;
      summaries.push({
        id: p.id,
        title: p.title,
        artist: p.artist,
        updatedAt: p.updatedAt,
        duration: p.duration,
      });
    } catch {
      // skip corrupt project file
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadProject(id: string): KaraokeProject | null {
  const safeId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '');
  const pPath = path.join(PROJECTS_DIR, `${safeId}.json`);
  if (!fs.existsSync(pPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pPath, 'utf-8')) as KaraokeProject;
  } catch {
    return null;
  }
}

export function saveProject(project: KaraokeProject): KaraokeProject {
  ensureDataDirs();
  const safeId = project.id.replace(/[^a-zA-Z0-9_-]/g, '') || `proj_${Date.now().toString(36)}`;
  const toSave: KaraokeProject = {
    ...project,
    id: safeId,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(PROJECTS_DIR, `${safeId}.json`), JSON.stringify(toSave, null, 2), 'utf-8');
  return toSave;
}

export function deleteProject(id: string): boolean {
  const safeId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '');
  const pPath = path.join(PROJECTS_DIR, `${safeId}.json`);
  if (!fs.existsSync(pPath)) return false;
  fs.unlinkSync(pPath);
  return true;
}
