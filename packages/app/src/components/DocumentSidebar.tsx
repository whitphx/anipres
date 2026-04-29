import {
  Github,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  Plus,
  Settings,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import type { DocumentMeta } from "../documents/types";
import type { ColorSchemePreference } from "../hooks/useColorScheme";
import { AccountSettingsModal } from "./AccountSettingsModal";
import { ColorSchemeSwitcher } from "./ColorSchemeSwitcher";
import { DocumentListItem } from "./DocumentListItem";
import { NetworkStatus } from "./NetworkStatus";
import styles from "./DocumentSidebar.module.css";

interface DocumentSidebarProps {
  colorSchemePreference: ColorSchemePreference;
  onColorSchemeChange: (next: ColorSchemePreference) => void;
}

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

export function DocumentSidebar({
  colorSchemePreference,
  onColorSchemeChange,
}: DocumentSidebarProps) {
  const {
    documents,
    activeDocumentId,
    selectDocument,
    createDocument,
    deleteDocument,
    renameDocument,
    convertToSynced,
    converting,
    conversionErrors,
  } = useDocumentManagerContext();

  const { user, loginWithGitHub, loginWithGoogle, logout } = useAuth();

  const [collapsed, setCollapsed] = useState(false);

  // Surface the post-OAuth-callback flash. The worker redirects to
  // `/?account_link=success|already_linked` on a successful link or
  // `/?account_link_error=...` on conflict; we read the params at
  // mount via lazy state init (avoids the React lint trap of
  // synchronously setting state in an effect), pop the modal open,
  // and the effect below strips the params from the URL so a refresh
  // doesn't re-show the flash.
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

  const { syncedDocs, localDocs } = useMemo(() => {
    const synced: DocumentMeta[] = [];
    const local: DocumentMeta[] = [];
    for (const doc of documents) {
      (doc.source === "synced" ? synced : local).push(doc);
    }
    return { syncedDocs: synced, localDocs: local };
  }, [documents]);

  const showGroupHeaders = syncedDocs.length > 0 && localDocs.length > 0;

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.toggleButton}
        onClick={() => setCollapsed(false)}
        title="Show sidebar"
        aria-label="Show sidebar"
      >
        <Menu size={16} />
      </button>
    );
  }

  // The convert action only makes sense when the user is logged in,
  // i.e. when there is a synced destination to migrate the doc into.
  const onConvert = user !== null ? convertToSynced : undefined;

  const renderGroup = (docs: DocumentMeta[]) =>
    docs.map((doc) => (
      <DocumentListItem
        key={doc.id}
        doc={doc}
        isActive={doc.id === activeDocumentId}
        onSelect={selectDocument}
        onRename={renameDocument}
        onDelete={deleteDocument}
        onConvert={onConvert}
        isConverting={converting.has(doc.id)}
        conversionError={conversionErrors.get(doc.id)}
      />
    ));

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Documents</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            className={styles.newButton}
            onClick={() => createDocument()}
          >
            <Plus size={14} /> New
          </button>
          <button
            type="button"
            className={styles.collapseButton}
            onClick={() => setCollapsed(true)}
            title="Hide sidebar"
            aria-label="Hide sidebar"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>
      <div className={styles.list}>
        {showGroupHeaders && syncedDocs.length > 0 && (
          <div className={styles.groupHeader}>Synced</div>
        )}
        {renderGroup(syncedDocs)}
        {showGroupHeaders && localDocs.length > 0 && (
          <div className={styles.groupHeader}>Local</div>
        )}
        {renderGroup(localDocs)}
      </div>
      <div className={styles.footer}>
        <NetworkStatus />
        {user ? (
          <>
            <button
              type="button"
              className={styles.authButton}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={14} /> Account settings
            </button>
            <button
              type="button"
              className={styles.authButton}
              onClick={logout}
            >
              <LogOut size={14} /> Log out
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.authButton}
              onClick={loginWithGitHub}
            >
              <Github size={14} /> Log in with GitHub
            </button>
            <button
              type="button"
              className={styles.authButton}
              onClick={loginWithGoogle}
            >
              <LogIn size={14} /> Log in with Google
            </button>
          </>
        )}
        <ColorSchemeSwitcher
          preference={colorSchemePreference}
          onChange={onColorSchemeChange}
        />
      </div>
      {/* Gating on `user` (in addition to `settingsOpen`) makes the
          modal unmount the moment the user logs out, so it can't keep
          rendering the previous user's cached identity list during
          the brief window before SWR revalidates. */}
      {settingsOpen && user && (
        <AccountSettingsModal
          onClose={() => {
            setSettingsOpen(false);
            setLinkFlash(null);
          }}
          initialFlash={linkFlash}
        />
      )}
    </div>
  );
}
