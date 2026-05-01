import { ChevronDown, Menu, PanelLeftClose, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { getConversionErrorMessage } from "../documents/conversion-error-message";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import type { DocumentMeta, DocumentSource } from "../documents/types";
import type { ColorSchemePreference } from "../hooks/useColorScheme";
import { AccountFooter } from "./AccountFooter";
import { ColorSchemeSwitcher } from "./ColorSchemeSwitcher";
import { DocumentListItem } from "./DocumentListItem";
import { NetworkStatus } from "./NetworkStatus";
import styles from "./DocumentSidebar.module.css";

interface DocumentSidebarProps {
  colorSchemePreference: ColorSchemePreference;
  onColorSchemeChange: (next: ColorSchemePreference) => void;
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

  const { user } = useAuth();
  const loggedIn = user !== null;

  const [collapsed, setCollapsed] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!newMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!newMenuContainerRef.current?.contains(e.target as Node)) {
        setNewMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNewMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [newMenuOpen]);

  const conversionAnnouncement = useMemo(() => {
    for (const [id, err] of conversionErrors) {
      const doc = documents.find((d) => d.id === id);
      if (doc) {
        return `Failed to upload ${doc.title} to cloud: ${getConversionErrorMessage(err)}`;
      }
    }
    if (converting.size === 0) return "";
    if (converting.size === 1) {
      const id = [...converting][0];
      const doc = documents.find((d) => d.id === id);
      if (doc) return `Uploading ${doc.title} to cloud.`;
    }
    return `Uploading ${converting.size} documents to cloud.`;
  }, [converting, conversionErrors, documents]);

  const { syncedDocs, localDocs } = useMemo(() => {
    const synced: DocumentMeta[] = [];
    const local: DocumentMeta[] = [];
    for (const doc of documents) {
      (doc.source === "synced" ? synced : local).push(doc);
    }
    return { syncedDocs: synced, localDocs: local };
  }, [documents]);

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

  const onConvert = loggedIn ? convertToSynced : undefined;

  const handleCreate = (source: DocumentSource) => {
    setNewMenuOpen(false);
    void createDocument({ source });
  };

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
        <div className={styles.headerActions}>
          {loggedIn ? (
            <div ref={newMenuContainerRef} className={styles.newMenuContainer}>
              <button
                type="button"
                className={styles.newButton}
                onClick={() => setNewMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={newMenuOpen}
              >
                <Plus size={14} /> New <ChevronDown size={12} />
              </button>
              {newMenuOpen && (
                <div role="menu" className={styles.newMenu}>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.newMenuItem}
                    onClick={() => handleCreate("synced")}
                  >
                    Synced
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.newMenuItem}
                    onClick={() => handleCreate("local")}
                  >
                    Local
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              className={styles.newButton}
              onClick={() => handleCreate("local")}
            >
              <Plus size={14} /> New
            </button>
          )}
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
        {loggedIn ? (
          <>
            <div className={styles.groupHeader}>Synced</div>
            {syncedDocs.length > 0 ? (
              renderGroup(syncedDocs)
            ) : (
              <div className={styles.emptyGroup}>No synced documents</div>
            )}
            <div className={styles.groupHeader}>Local</div>
            {localDocs.length > 0 ? (
              renderGroup(localDocs)
            ) : (
              <div className={styles.emptyGroup}>No local documents</div>
            )}
          </>
        ) : (
          renderGroup(documents)
        )}
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={styles.srOnly}
      >
        {conversionAnnouncement}
      </div>
      <div className={styles.footer}>
        <NetworkStatus />
        <AccountFooter />
        <ColorSchemeSwitcher
          preference={colorSchemePreference}
          onChange={onColorSchemeChange}
        />
      </div>
    </div>
  );
}
