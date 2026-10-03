import { SidePanelOpenFilled } from '@carbon/icons-react'
import { ExternalLink } from 'lucide-react'
import { Button } from './ui/button.tsx'
import { ThemeToggle, type ThemeToggleLabels } from './ui/theme-toggle.tsx'

const FASTVIDEO_REPO_URL = 'https://haoailab.com/blogs/dreamverse/'

/** Localized copy of {@link Header}, supplied by the package that renders the header. */
export interface HeaderLabels extends ThemeToggleLabels {
  /** Accessible name of the sidebar toggle. */
  toggleSidebar: string
  /** Tooltip of the FastVideo logo link. */
  repositoryLink: string
  /** Alternative text of the FastVideo logo. */
  logo: string
  /** Text of the waitlist link buttons. */
  joinWaitlist: string
}

interface Props {
  onToggleSidebar?: () => void
  labels: HeaderLabels
}

/** Show the sidebar toggle, FastVideo logo link, waitlist links, and theme toggle. */
export default function Header({ onToggleSidebar, labels }: Props) {

  return (
    <header className="relative z-30 shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-y-2 px-4 pt-3 pb-2 sm:pt-4 sm:pb-3 sm:px-6">
        <div className="flex items-center gap-3">
          {onToggleSidebar && (
            <Button variant="outline" size="icon" onClick={onToggleSidebar} aria-label={labels.toggleSidebar}>
              <SidePanelOpenFilled size={20} />
            </Button>
          )}
          <a href={FASTVIDEO_REPO_URL} target="_blank" rel="noopener noreferrer" title={labels.repositoryLink}>
            <img src="/logo.svg" alt={labels.logo} width={32} height={32} className="h-8 w-auto sm:h-9 transition-opacity hover:opacity-70" />
          </a>
          <div className="hidden sm:flex items-center gap-3">
            <a href="https://docs.google.com/forms/d/e/1FAIpQLSe5zpO1iD8Ds-Ih-fOLm64qd7YZVvuvAyHuJaAfw1hkRHTe_A/viewform?usp=publish-editor" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="gap-1.5 rounded-full px-3 text-xs">
                {labels.joinWaitlist}
                <ExternalLink className="size-3 opacity-60" />
              </Button>
            </a>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle labels={labels} />
        </div>
      </div>

      <div className="flex sm:hidden items-center gap-2 px-4 pb-3">
        <a href="https://docs.google.com/forms/d/e/1FAIpQLSe5zpO1iD8Ds-Ih-fOLm64qd7YZVvuvAyHuJaAfw1hkRHTe_A/viewform?usp=publish-editor" target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm" className="gap-1.5 rounded-full px-3 text-xs">
            {labels.joinWaitlist}
            <ExternalLink className="size-3 opacity-60" />
          </Button>
        </a>
      </div>
    </header>
  )
}
