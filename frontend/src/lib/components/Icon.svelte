<script lang="ts">
  type IconName =
    | 'play' | 'pause' | 'skip-back' | 'skip-forward' | 'step-back' | 'step-forward'
    | 'scissors' | 'trash' | 'filter' | 'settings' | 'plus' | 'link' | 'download'
    | 'queue' | 'check' | 'alert' | 'chevron-right' | 'chevron-left' | 'close' | 'search'
    | 'grid' | 'waveform' | 'clock' | 'cpu' | 'volume' | 'volume-mute' | 'expand' | 'compress'
    | 'rewind' | 'fast-forward' | 'zoom-in' | 'zoom-out' | 'keyboard' | 'back' | 'shuffle'
    | 'eye' | 'bookmark' | 'film' | 'arrow-left' | 'arrow-right' | 'gauge';

  interface Props {
    name: IconName;
    size?: number;
    fill?: boolean;
    strokeWidth?: number;
  }

  let { name, size = 20, fill = false, strokeWidth = 1.5 }: Props = $props();

  // Multi-path icons use arrays joined by space; single-path use a string.
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
    'chevron-left': 'M15 6l-6 6 6 6',
    close: 'M6 6l12 12M18 6L6 18',
    search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    waveform: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0',
    clock: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2',
    cpu: 'M6 6h12v12H6zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3',
    volume: 'M11 5L6 9H2v6h4l5 4zM15 9a3 3 0 010 6M18 6a7 7 0 010 12',
    'volume-mute': 'M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6',
    expand: 'M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6',
    compress: 'M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6',
    rewind: 'M11 5L2 12l9 7zM22 5l-9 7 9 7z',
    'fast-forward': 'M2 5l9 7-9 7zM13 5l9 7-9 7z',
    'zoom-in': 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6M11 8v6',
    'zoom-out': 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6',
    keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8',
    back: 'M19 12H5M12 19l-7-7 7-7',
    shuffle: 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
    eye: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8a4 4 0 100 8 4 4 0 000-8z',
    bookmark: 'M6 4h12v16l-6-4-6 4z',
    film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16M15 4v16',
    'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
    'arrow-right': 'M5 12h14M12 5l7 7-7 7',
    gauge: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 12l4-3',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={fill ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={paths[name]} />
</svg>
