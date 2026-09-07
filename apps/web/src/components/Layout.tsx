import { useRef } from 'react';
import { Link, Outlet } from 'react-router-dom';

import { getMeta } from '../api/client';
import type { AuthUser } from '../api/types';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/authState';
import { useTheme } from '../theme/themeState';
import { CandidatePinBanner } from './CandidatePinBanner';
import { DiscordLogo } from './DiscordLogo';

/**
 * "Role-aware navigation — but every check re-enforced server-side; hiding a
 * button is not authorization" (#15's own scope note). Every link this
 * shows is exactly that: a convenience, not a gate — a normal user who
 * guesses `/moderation` still hits the same 403 the API itself would give
 * them. ModerationPage/AdminPage do not trust this any more than the API:
 * the API revalidates Discord capability for protected actions.
 *
 * The Discord invite is the one link here that is not a convenience over a
 * server-side check — joining the community is the opposite of gated, so it
 * renders for every visitor, logged in or not, whenever one is configured.
 */
function Nav() {
  const { status, user, login, logout } = useAuth();
  const metaState = useApi((signal) => getMeta(signal), []);
  const inviteUrl = metaState.status === 'ready' ? metaState.data.discordInviteUrl : null;

  return (
    <nav className="flex items-center gap-4 text-sm">
      {inviteUrl && (
        <a
          href={inviteUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Discord"
          title="Join the Discord"
          // text-ink is not decoration here: the mark's face is `currentColor`,
          // so this is what actually colors the logo, keeping it identical to
          // the nav links beside it in both themes.
          className="flex items-center rounded-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <DiscordLogo />
        </a>
      )}
      <Link to="/editor" className="text-ink hover:text-accent">
        Create
      </Link>
      <Link to="/developer" className="text-ink hover:text-accent">
        Developer
      </Link>
      {status === 'loading' ? null : status === 'anonymous' ? (
        <button
          type="button"
          onClick={login}
          aria-label="Log in with Discord"
          title="Log in with Discord"
          className="cursor-pointer px-3 py-1.5 text-sm text-ink hover:text-accent"
        >
          {/*
            The glyph alone would leave this control with no accessible name at
            all — the aria-label above is what a screen reader announces, and
            the title is what a mouse user gets on hover.
          */}
          <span aria-hidden="true">🔒</span>
        </button>
      ) : (
        <>
          <Link to="/me/layouts" className="text-ink hover:text-accent">
            My layouts
          </Link>
          {user && (user.role === 'moderator' || user.role === 'admin') && (
            <Link to="/moderation" className="text-ink hover:text-accent">
              Moderation
            </Link>
          )}
          {user && (user.role === 'moderator' || user.role === 'admin') && (
            <Link to="/moderation/webhooks" className="text-ink hover:text-accent">
              Webhooks
            </Link>
          )}
          {user?.role === 'admin' && (
            <Link to="/admin" className="text-ink hover:text-accent">
              Admin
            </Link>
          )}
          {user?.role === 'admin' && (
            <Link to="/admin/history" className="text-ink hover:text-accent">
              History
            </Link>
          )}
          {user && <AccountMenu user={user} onLogout={logout} />}
        </>
      )}
    </nav>
  );
}

/**
 * The logged-in half of the header: the Discord avatar, doubling as the toggle
 * for a small account menu (#66).
 *
 * `<details>/<summary>` rather than a menu library or a useState + outside-click
 * listener — the same native disclosure this codebase already uses for the
 * endpoint rows on /developer and the audit-log entry details. It costs no
 * dependency and no JS state, and it is keyboard- and screen-reader-operable
 * for free. The one thing it does not give us is closing on an outside click;
 * choosing an item does close it, via the ref below, because leaving the menu
 * hanging open over the page after navigating is the case that actually bites.
 */
function AccountMenu({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (menuRef.current) menuRef.current.open = false;
  };

  return (
    <details ref={menuRef} className="relative">
      <summary
        aria-label={`Account menu for ${user.displayName}`}
        title={user.displayName}
        className="flex cursor-pointer list-none items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            width={32}
            height={32}
            className="size-8 rounded-full border-2 border-border object-cover hover:border-accent"
          />
        ) : (
          // Discord accounts can sit on a default avatar the API reports as null.
          <span className="flex size-8 items-center justify-center rounded-full border-2 border-border bg-surface-alt text-sm text-ink hover:border-accent">
            {user.displayName.slice(0, 1).toUpperCase()}
          </span>
        )}
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-48 border-2 border-border bg-surface py-1 text-left shadow-lg">
        <p className="truncate px-3 py-1 text-muted">{user.displayName}</p>
        {user.discordId && (
          <Link
            to={`/authors/${user.discordId}`}
            onClick={close}
            className="block px-3 py-1.5 text-ink hover:bg-surface-alt hover:text-accent"
          >
            Visit profile
          </Link>
        )}
        <button
          type="button"
          onClick={() => {
            close();
            onLogout();
          }}
          className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-alt hover:text-accent"
        >
          Log out
        </button>
      </div>
    </details>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className="flex size-8 cursor-pointer items-center justify-center text-sm text-ink hover:text-accent"
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="flex items-center justify-between gap-4 border-b-2 border-border px-6 py-4">
        <Link to="/" className="font-display text-xl tracking-tight text-ink">
          Pixel Index
        </Link>
        <div className="flex items-center gap-4">
          <Nav />
          <ThemeToggle />
        </div>
      </header>
      <CandidatePinBanner />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
