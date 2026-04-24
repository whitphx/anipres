import { CloudUpload, Loader2, X } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import type { DocumentMeta } from "../documents/types";
import styles from "./DocumentListItem.module.css";

interface DocumentListItemProps {
  doc: DocumentMeta;
  isActive: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /**
   * When provided and `doc.origin === "local"`, the item renders a
   * "Upload to cloud" affordance that triggers migration to the synced
   * repository. Absent when the user is logged out (no synced
   * destination) or when the doc is already synced.
   */
  onConvert?: (id: string) => void;
  /** True while this specific doc is being migrated via onConvert. */
  isConverting?: boolean;
  /**
   * Error from the most recent convert attempt on this doc. Absent when
   * there is no prior error or the error belongs to a different doc.
   */
  conversionError?: Error;
}

export function DocumentListItem({
  doc,
  isActive,
  onSelect,
  onRename,
  onDelete,
  onConvert,
  isConverting = false,
  conversionError,
}: DocumentListItemProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(doc.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== doc.title) {
      onRename(doc.id, trimmed);
    } else {
      setEditValue(doc.title);
    }
    setEditing(false);
  };

  const canConvert = onConvert !== undefined && doc.origin === "local";
  const convertTitle = isConverting
    ? "Uploading…"
    : conversionError
      ? `Upload failed: ${conversionError.message}. Click to retry.`
      : "Upload to cloud";
  const convertAriaLabel = isConverting
    ? `Uploading ${doc.title} to cloud`
    : conversionError
      ? `Retry uploading ${doc.title} to cloud (previous attempt failed)`
      : `Upload ${doc.title} to cloud`;

  return (
    <div
      role="button"
      tabIndex={0}
      className={`${styles.item} ${isActive ? styles.active : ""}`}
      onClick={() => {
        if (!editing) onSelect(doc.id);
      }}
      onKeyDown={(e) => {
        if (!editing && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(doc.id);
        }
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditValue(doc.title);
        setEditing(true);
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          className={styles.titleInput}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setEditValue(doc.title);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className={styles.title}>{doc.title}</span>
      )}
      {canConvert && (
        <button
          type="button"
          className={`${styles.convertButton} ${
            isConverting ? styles.convertButtonBusy : ""
          } ${conversionError ? styles.convertButtonError : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (isConverting) return;
            onConvert?.(doc.id);
          }}
          disabled={isConverting}
          title={convertTitle}
          aria-label={convertAriaLabel}
        >
          {isConverting ? (
            <Loader2 size={14} className={styles.spinner} />
          ) : (
            <CloudUpload size={14} />
          )}
        </button>
      )}
      <button
        type="button"
        className={styles.deleteButton}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(doc.id);
        }}
        title="Delete document"
        aria-label="Delete document"
      >
        <X size={14} />
      </button>
    </div>
  );
}
