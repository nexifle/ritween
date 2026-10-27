import { useMemo } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { layoutStorage } from "../utils/local-storage";

/** Retain existing library storage keys, with guarded reads and validated sizes. */
export function usePersistentLayout(id: string, panelIds: readonly string[]) {
  const signature = panelIds.join("\0");
  const storage = useMemo(
    () => layoutStorage(signature.split("\0")),
    [signature],
  );
  return useDefaultLayout({ id, storage, onlySaveAfterUserInteractions: true });
}
