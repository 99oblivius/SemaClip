import { QueryClient } from '@tanstack/query-core';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 5000 } },
  });
  return { queryClient };
};
