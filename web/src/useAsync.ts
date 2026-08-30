import { useEffect, useState } from 'react';

interface State<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// Runs `fn` whenever any value in `deps` changes; tracks loading/error.
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): State<T> {
  const [state, setState] = useState<State<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => live && setState({ data, loading: false, error: null }))
      .catch(
        (err) =>
          live &&
          setState({ data: null, loading: false, error: (err as Error).message }),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
