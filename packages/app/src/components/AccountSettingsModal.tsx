import { Github, LogIn, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { apiClient } from "../lib/api-client";
import styles from "./AccountSettingsModal.module.css";

// SWR key for the typed-client `GET /auth/identities` fetch. Tuple
// rather than the URL string because the typed client is the sole
// caller — the cache key just needs to be stable across renders and
// recognizable at the `globalMutate` site.
const IDENTITIES_KEY = ["auth", "identities"] as const;

const ALL_PROVIDERS = ["github", "google"] as const;
type ProviderName = (typeof ALL_PROVIDERS)[number];

const PROVIDER_LABELS: Record<ProviderName, string> = {
  github: "GitHub",
  google: "Google",
};

const FLASH_MESSAGES: Record<
  string,
  { kind: "success" | "error"; text: string }
> = {
  // success codes (?account_link=...)
  success: {
    kind: "success",
    text: "Account connected.",
  },
  already_linked: {
    kind: "success",
    text: "That account is already linked.",
  },
  // error codes (?account_link_error=...)
  identity_in_use: {
    kind: "error",
    text: "That provider account is already linked to a different anipres account. Sign in there instead.",
  },
  server_error: {
    kind: "error",
    text: "Could not link the account. Please try again.",
  },
};

interface AccountSettingsModalProps {
  onClose: () => void;
  /**
   * Optional initial flash to show, passed in by the parent when the
   * URL query params indicate the modal is being opened in response
   * to a finished OAuth-link flow.
   *
   * The modal is mount/unmount-controlled by the parent — there is
   * no `open` prop. Mount = visible. SWR keeps the identities cache
   * across mounts, so subsequent opens are instant; the unmount-on-
   * close pattern still simplifies internal state (the parent owns
   * the flash, so it disappears as soon as the modal unmounts).
   */
  initialFlash?: { code: string; kind: "success" | "error" } | null;
}

export function AccountSettingsModal({
  onClose,
  initialFlash,
}: AccountSettingsModalProps) {
  // SWR handles cancellation, error/loading state, dedup, and cache
  // reuse on reopen — second-and-later opens of the modal in the same
  // session show the cached identity list immediately while a
  // background revalidation refreshes it. (Focus revalidation also
  // catches "user linked a provider in a second tab" without explicit
  // wiring; it doesn't help the primary flow because that flow does a
  // full-page redirect, but it's a free correctness backstop.)
  const { data: identities, error: loadError } = useSWR(
    IDENTITIES_KEY,
    async () => {
      const res = await apiClient.auth.identities.$get();
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      return res.json();
    },
  );
  const { mutate: globalMutate } = useSWRConfig();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Two-click confirm pattern for unlink: first click promotes the row
  // into a "Confirm / Cancel" state, second click on Confirm fires the
  // DELETE. Avoids the native window.confirm() (which has uneven UX
  // across browsers) and a modal-on-modal (which would be heavy for a
  // small action). `confirmingId` is the row key (`${provider}:${id}`)
  // currently in the confirm state, or null.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  // Focus the close button on mount so Esc-to-close works without
  // the user first having to tab into the dialog.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  // Esc-to-close. The backdrop click and X button cover mouse users.
  // If a row is mid-confirm, Esc cancels the confirm instead of
  // closing the whole modal — the user expects Esc to back out of the
  // most-recent prompt first.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmingId !== null) {
        setConfirmingId(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [confirmingId, onClose]);

  const linkedProviders = new Set(
    (identities ?? []).map((row) => row.provider),
  );
  const unlinkedProviders = ALL_PROVIDERS.filter(
    (p) => !linkedProviders.has(p),
  );
  const isLoading = identities === undefined && loadError === undefined;
  const canUnlinkAny = identities !== undefined && identities.length > 1;

  const flashConfig = initialFlash
    ? (FLASH_MESSAGES[initialFlash.code] ?? {
        kind: initialFlash.kind,
        text: "Account linking returned an unrecognized status.",
      })
    : null;

  const handleUnlink = async (provider: string, providerId: string) => {
    const rowId = `${provider}:${providerId}`;
    setUnlinkingId(rowId);
    setUnlinkError(null);
    try {
      const res = await apiClient.auth.identities[":provider"][
        ":provider_id"
      ].$delete({
        param: { provider, provider_id: providerId },
      });
      if (!res.ok) {
        // The typed client gives us a union over all `c.json(...)`
        // shapes (200, 409, 404). Status narrowing doesn't refine
        // that union for `.json()` here, so check fields explicitly.
        const body = await res.json().catch(() => null);
        if (
          res.status === 409 &&
          body &&
          "code" in body &&
          body.code === "last_identity"
        ) {
          setUnlinkError(
            "This is your only sign-in method — link another provider first.",
          );
        } else {
          setUnlinkError(
            (body && "error" in body ? body.error : null) ??
              `Request failed (${res.status}).`,
          );
        }
        return;
      }
      // Refresh the SWR cache so the row disappears. mutate() with no
      // value triggers a revalidation against the server, which is the
      // right behavior here — we want the canonical post-delete list.
      await globalMutate(IDENTITIES_KEY);
      setConfirmingId(null);
    } catch (err) {
      setUnlinkError(
        err instanceof Error ? err.message : "Could not unlink. Try again.",
      );
    } finally {
      setUnlinkingId(null);
    }
  };

  return (
    <div
      className={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-settings-title"
      >
        <div className={styles.header}>
          <h2 id="account-settings-title" className={styles.title}>
            Account settings
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close account settings"
          >
            <X size={16} />
          </button>
        </div>

        {flashConfig && (
          <div
            role={flashConfig.kind === "error" ? "alert" : "status"}
            className={`${styles.flash} ${
              flashConfig.kind === "success"
                ? styles.flashSuccess
                : styles.flashError
            }`}
          >
            {flashConfig.text}
          </div>
        )}

        {unlinkError !== null && (
          <div role="alert" className={`${styles.flash} ${styles.flashError}`}>
            {unlinkError}
          </div>
        )}

        {/* Single loading / error gate around both sections. Rendering
            the sections eagerly (with the connect-buttons list filled in
            from an empty `linkedProviders` Set) caused the modal to
            open at "all providers offered as Connect" height and shrink
            once the fetch revealed which providers were already linked.
            Hold both sections behind the gate so the modal opens at its
            final size in one pass. */}
        {isLoading && <p className={styles.empty}>Loading…</p>}
        {loadError !== undefined && (
          <p className={styles.empty}>
            Could not load: {loadError.message ?? String(loadError)}
          </p>
        )}
        {identities !== undefined && (
          <>
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Linked sign-in providers</h3>
              {identities.length === 0 ? (
                <p className={styles.empty}>No providers linked.</p>
              ) : (
                <ul className={styles.identityList}>
                  {identities.map((identity) => {
                    const rowId = `${identity.provider}:${identity.provider_id}`;
                    const isConfirming = confirmingId === rowId;
                    const isUnlinking = unlinkingId === rowId;
                    return (
                      <li key={rowId} className={styles.identityItem}>
                        <ProviderIcon provider={identity.provider} />
                        <span className={styles.identityProvider}>
                          {PROVIDER_LABELS[identity.provider as ProviderName] ??
                            identity.provider}
                        </span>
                        <span className={styles.identityDate}>
                          Connected {formatDate(identity.created_at)}
                        </span>
                        {canUnlinkAny &&
                          (isConfirming ? (
                            <span className={styles.identityActions}>
                              <button
                                type="button"
                                className={styles.confirmUnlinkButton}
                                onClick={() =>
                                  handleUnlink(
                                    identity.provider,
                                    identity.provider_id,
                                  )
                                }
                                disabled={isUnlinking}
                              >
                                {isUnlinking ? "Unlinking…" : "Confirm"}
                              </button>
                              <button
                                type="button"
                                className={styles.cancelUnlinkButton}
                                onClick={() => setConfirmingId(null)}
                                disabled={isUnlinking}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={styles.unlinkButton}
                              onClick={() => {
                                setUnlinkError(null);
                                setConfirmingId(rowId);
                              }}
                              aria-label={`Unlink ${
                                PROVIDER_LABELS[
                                  identity.provider as ProviderName
                                ] ?? identity.provider
                              }`}
                              title="Unlink"
                            >
                              <Trash2 size={14} />
                            </button>
                          ))}
                      </li>
                    );
                  })}
                </ul>
              )}
              {identities.length === 1 && (
                <p className={styles.singleIdentityNote}>
                  Link another provider before unlinking this one.
                </p>
              )}
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Connect another provider</h3>
              {unlinkedProviders.length === 0 ? (
                <p className={styles.allLinkedNote}>
                  All supported providers are already linked.
                </p>
              ) : (
                <div className={styles.connectButtons}>
                  {unlinkedProviders.map((provider) => (
                    <button
                      key={provider}
                      type="button"
                      className={styles.connectButton}
                      onClick={() => {
                        window.location.href = `/auth/${provider}`;
                      }}
                    >
                      <ProviderIcon provider={provider} />
                      Connect {PROVIDER_LABELS[provider]}
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "github") return <Github size={14} aria-hidden />;
  return <LogIn size={14} aria-hidden />;
}

function formatDate(unixMs: number): string {
  return new Date(unixMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
