import { useId, useRef } from "react";
import { Icon } from "../components/icon";
import { miniButton } from "../components/control-styles";

export function ExportHelp() {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  return (
    <>
      <button
        type="button"
        className={miniButton}
        title="About exports"
        aria-label="About exports"
        onClick={() => dialog.current?.showModal()}
      >
        <Icon name="info" size={13} />
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={title}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
        className="fixed inset-0 m-auto w-[340px] max-w-[calc(100vw-32px)] rounded-md border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="flex h-10 items-center justify-between border-b border-separator px-4">
          <h3 id={title} className="text-xs font-medium">
            About exports
          </h3>
          <button
            type="button"
            autoFocus
            className={miniButton}
            aria-label="Close export help"
            onClick={() => dialog.current?.close()}
          >
            <Icon name="cancel" size={13} />
          </button>
        </div>
        <dl className="space-y-4 p-4 text-[11px] leading-relaxed">
          <div>
            <dt className="mb-1 font-medium">Keep a copy</dt>
            <dd className="text-muted-foreground">
              Exports run on the server, even if you close this tab. Download
              files before stopping the server; normal shutdown removes
              temporary files.
            </dd>
          </div>
          <div>
            <dt className="mb-1 font-medium">After an unexpected shutdown</dt>
            <dd className="text-muted-foreground">
              Completed files can be recovered the next time you open this
              project. Unfinished exports need to be started again.
            </dd>
          </div>
          <div>
            <dt className="mb-1 font-medium">Storage & queue</dt>
            <dd className="text-muted-foreground">
              Up to 4 GiB of completed files and 50 records per session. Delete
              older exports to free space. One job renders at a time, with up to
              three active jobs.
            </dd>
          </div>
        </dl>
      </dialog>
    </>
  );
}
