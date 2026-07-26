<script lang="ts">
  type IconName =
    | 'play' | 'pause' | 'skip-back' | 'skip-forward' | 'step-back' | 'step-forward'
    | 'scissors' | 'trash' | 'filter' | 'settings' | 'plus' | 'link' | 'download'
    | 'queue' | 'check' | 'alert' | 'chevron-right' | 'close' | 'search'
    | 'grid' | 'waveform' | 'clock' | 'cpu';

  interface Props {
    name: IconName;
    size?: number;
    fill?: boolean;
  }

  let { name, size = 20, fill = false }: Props = $props();

  const paths: Record<IconName, string> = {
    play: 'M5 5l14 7-14 7z',
    pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
    'skip-back': 'M19 5L9 12l10 7zM5 4h2v16H5z',
    'skip-forward': 'M5 5l10 7L5 19zM17 4h2v16h-2z',
    'step-back': 'M15 6L8 12l7 6z',
    'step-forward': 'M9 6l7 6-7 6z',
    scissors: 'M6 4a2 2 0 100 4 2 2 0 000-4zm0 12a2 2 0 100 4 2 2 0 000-4zM6 8l14 8M6 16L20 8',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    filter: 'M3 5h18l-7 8v6l-4-2v-4z',
    settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
    plus: 'M12 5v14M5 12h14',
    link: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1',
    download: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2',
    queue: 'M4 6h16M4 12h16M4 18h10',
    check: 'M5 12l5 5L20 7',
    alert: 'M12 3l10 17H2zM12 9v5M12 17h.01',
    'chevron-right': 'M9 6l6 6-6 6',
    close: 'M6 6l12 12M18 6L6 18',
    search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    waveform: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0',
    clock: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2',
    cpu: 'M6 6h12v12H6zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={fill ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={paths[name]} />
</svg>
