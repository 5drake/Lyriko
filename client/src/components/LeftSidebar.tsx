import type { KaraokeProject } from '@shared/types';
import { DesignTab } from './DesignTab';

interface LeftSidebarProps {
  project: KaraokeProject;
  onUpdateProject: (updater: (prev: KaraokeProject) => KaraokeProject) => void;
  onBackgroundLoaded: (
    kind: 'image' | 'video',
    fileId: string,
    originalName: string,
    url: string,
    keepBgType?: boolean
  ) => void;
}

export function LeftSidebar({
  project,
  onUpdateProject,
  onBackgroundLoaded,
}: LeftSidebarProps) {
  return (
    <aside
      data-tour="sidebar-style"
      className="flex w-[328px] xl:w-[360px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0b101d] overflow-hidden"
    >
      <DesignTab
        project={project}
        onUpdateProject={onUpdateProject}
        onBackgroundLoaded={onBackgroundLoaded}
      />
    </aside>
  );
}
