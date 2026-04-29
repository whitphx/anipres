import { Menu, PanelLeftClose, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { getConversionErrorMessage } from "../documents/conversion-error-message";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import type { DocumentMeta } from "../documents/types";
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

  // The convert action only makes sense when the user is logged in,
  // i.e. when there is a synced destination to migrate the doc into.
  // Auth state lives in `AccountFooter`'s subtree for the rest of the
  // sidebar's account-related UI; the sidebar still needs `user` here
  // to decide whether to expose the convert affordance per row.
  const { user } = useAuth();

  const [collapsed, setCollapsed] = useState(false);

  // Announcement string for the convert-to-synced aria-live region.
  // The convert-to-synced button itself updates its `title` /
  // `aria-label` in place, but those only get re-announced when the
  // button receives focus. The polite live region below announces
  // start / failure transitions to screen readers as they happen,
  // without taking focus.
  //
  // Errors take precedence over in-flight state: when a doc fails
  // mid-conversion, useDocumentManager moves it from `converting`
  // into `conversionErrors`, so the error branch fires on the
  // failure transition. Successful completions don't appear here
  // (the doc just moves out of `converting` into the synced group);
  // the visible badge change is enough.
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
