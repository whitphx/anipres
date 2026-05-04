import { Github, LogIn, LogOut, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { AccountSettingsModal } from "./AccountSettingsModal";
import styles from "./AccountFooter.module.css";

// Pull the account-link flash from the current URL — set by the
// worker's redirect after the OAuth callback resolves a link
// operation. Returns null when neither query param is present
// (the common case: ordinary navigation, not arriving from a link
// flow).
function readLinkFlashFromUrl(): {
  code: string;
  kind: "success" | "error";
} | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const success = params.get("account_link");
  const error = params.get("account_link_error");
  if (!success && !error) return null;
  return {
    code: error ?? success ?? "",
    kind: error ? "error" : "success",
  };
}

/**
 * Account-related controls for the sidebar footer. Owns its own
 * lifecycle:
 *
 * - When logged out: renders the per-provider login buttons.
 * - When logged in: renders the "Account settings" button (opens
 *   the modal) and the "Log out" button.
 *
 * Also owns the post-OAuth-link flash: reads `?account_link[_error]`
 * params from the URL on mount, pops the modal open with the flash
 * visible, and strips the params via `replaceState` so a refresh
 * doesn't re-show it. Lives here (rather than in `DocumentSidebar`)
 * so the sidebar stays a document-list component and doesn't grow
 * account-management concerns.
 */
export function AccountFooter() {
  const { user, loginWithGitHub, loginWithGoogle, logout } = useAuth();

  // Lazy state init reads the URL once at mount — avoids the React
  // lint trap of synchronously setting state in an effect, and lands
  // the modal open on first paint when arriving from an OAuth-link
  // redirect.
  const [linkFlash, setLinkFlash] = useState<{
    code: string;
    kind: "success" | "error";
  } | null>(readLinkFlashFromUrl);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(
    () => readLinkFlashFromUrl() !== null,
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("account_link") && !params.has("account_link_error")) {
      return;
    }
    params.delete("account_link");
    params.delete("account_link_error");
    const search = params.toString();
    const next =
      window.location.pathname +
      (search ? `?${search}` : "") +
      window.location.hash;
    window.history.replaceState({}, "", next);
  }, []);

  if (!user) {
    return (
      <>
        <button
          type="button"
          className={styles.button}
          onClick={loginWithGitHub}
        >
          <Github size={14} /> Log in with GitHub
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={loginWithGoogle}
        >
          <LogIn size={14} /> Log in with Google
        </button>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className={styles.button}
        onClick={() => setSettingsOpen(true)}
      >
        <Settings size={14} /> Account settings
      </button>
      <button type="button" className={styles.button} onClick={logout}>
        <LogOut size={14} /> Log out
      </button>
      {/* Gating on `user` (in addition to `settingsOpen`) makes the
          modal unmount the moment the user logs out, so it can't
          keep rendering the previous user's cached identity list
          during the brief window before SWR revalidates. */}
      {settingsOpen && user && (
        <AccountSettingsModal
          onClose={() => {
            setSettingsOpen(false);
            setLinkFlash(null);
          }}
          initialFlash={linkFlash}
        />
      )}
    </>
  );
}
