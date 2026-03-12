import { useState, useRef, useEffect } from "react";
import type { DocumentMeta } from "../documents/types";
import styles from "./DocumentListItem.module.css";

interface DocumentListItemProps {
  doc: DocumentMeta;
  isActive: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function DocumentListItem({
  doc,
  isActive,
  onSelect,
  onRename,
  onDelete,
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

  return (
    <div
      className={`${styles.item} ${isActive ? styles.active : ""}`}
      onClick={() => {
        if (!editing) onSelect(doc.id);
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
      <button
        className={styles.deleteButton}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(doc.id);
        }}
        title="Delete document"
      >
        ×
      </button>
    </div>
  );
}
