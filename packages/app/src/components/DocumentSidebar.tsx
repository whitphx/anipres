import { Menu, PanelLeftClose, Plus } from "lucide-react";
import { useMemo, useState } from "react";
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

  const renderSection = (
    label: string,
    source: DocumentSource,
    docs: DocumentMeta[],
    emptyMessage: string,
  ) => (
    <>
      <div className={styles.groupHeader}>
        <span className={styles.groupHeaderLabel}>{label}</span>
        <button
          type="button"
          className={styles.groupAddButton}
          onClick={() => handleCreate(source)}
          title={`New ${label.toLowerCase()} document`}
          aria-label={`New ${label.toLowerCase()} document`}
        >
          <Plus size={12} />
        </button>
      </div>
      {docs.length > 0 ? (
        renderGroup(docs)
      ) : (
        <div className={styles.emptyGroup}>{emptyMessage}</div>
      )}
    </>
  );

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Documents</span>
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
      <div className={styles.list}>
        {loggedIn &&
          renderSection("Synced", "synced", syncedDocs, "No synced documents")}
        {renderSection("Local", "local", localDocs, "No local documents")}
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
