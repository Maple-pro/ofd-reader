import { useCallback, useEffect, useState } from 'react';
import type { LoadProgress, OfdDocument } from '../lib/types';
import { loadOfdDocument } from '../lib/document';

export interface DocumentState {
  doc: OfdDocument | null;
  file: File | null;
  loading: boolean;
  progress: LoadProgress | null;
  error: string | null;
}

export function useOfdDocument() {
  const [state, setState] = useState<DocumentState>({
    doc: null,
    file: null,
    loading: false,
    progress: null,
    error: null,
  });

  const open = useCallback(async (file: File) => {
    setState((prev) => {
      prev.doc?.dispose();
      return { doc: null, file, loading: true, progress: { phase: 'reading', message: '准备中…' }, error: null };
    });

    try {
      const doc = await loadOfdDocument(file, {
        onProgress: (progress) => setState((prev) => (prev.loading ? { ...prev, progress } : prev)),
      });
      setState({ doc, file, loading: false, progress: null, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState({ doc: null, file, loading: false, progress: null, error: message });
    }
  }, []);

  const close = useCallback(() => {
    setState((prev) => {
      prev.doc?.dispose();
      return { doc: null, file: null, loading: false, progress: null, error: null };
    });
  }, []);

  useEffect(() => () => {
    setState((prev) => {
      prev.doc?.dispose();
      return prev;
    });
  }, []);

  return { ...state, open, close };
}
