import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (props: P) => ({
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props,
});

export const IconPointer = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 3l14 8-6.5 1.5L9 19z" />
  </svg>
);
export const IconHand = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 11V5.5a1.5 1.5 0 013 0V11m0-5a1.5 1.5 0 013 0v6m0-4a1.5 1.5 0 013 0v7a6 6 0 01-6 6h-1.5a6 6 0 01-4.8-2.4L3 14.8a1.5 1.5 0 012.3-1.9L8 15" />
  </svg>
);
export const IconRect = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2" />
    <rect x="8" y="8" width="8" height="8" rx="1" strokeDasharray="2 2" />
  </svg>
);
export const IconLasso = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4c4.4 0 8 2.2 8 5s-3.6 5-8 5-8-2.2-8-5 3.6-5 8-5z" strokeDasharray="3 2" />
    <path d="M7 13.5c-1 1.5-1 3 0 4.5s2.5 1.5 3 3" />
  </svg>
);
export const IconBrush = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 3l7 7-8.5 8.5a3 3 0 01-4.2 0l-2.8-2.8a3 3 0 010-4.2z" />
    <path d="M5 16l-2 5 5-2" />
  </svg>
);
export const IconEraser = (p: P) => (
  <svg {...base(p)}>
    <path d="M16.5 3.5l4 4L10 18H6l-3-3z" />
    <path d="M6 18h15" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconBack = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const IconChevron = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);
export const IconCrop = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 2v14a2 2 0 002 2h14" />
    <path d="M2 6h14a2 2 0 012 2v14" />
  </svg>
);
export const IconRemoveBg = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M3 21L21 3" />
    <path d="M9 3l-6 6M21 15l-6 6" />
  </svg>
);
export const IconGrade = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8.5" r="4.5" />
    <circle cx="8" cy="15" r="4.5" />
    <circle cx="16" cy="15" r="4.5" />
  </svg>
);
export const IconRelight = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
  </svg>
);
export const IconLayers = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l9 5-9 5-9-5z" />
    <path d="M3 13l9 5 9-5" />
    <path d="M3 17l9 5 9-5" />
  </svg>
);
export const IconEdit = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13 7l4 4" />
  </svg>
);
export const IconSparkle = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M12 2l1.8 5.7L19.5 9.5l-5.7 1.8L12 17l-1.8-5.7L4.5 9.5l5.7-1.8z" />
    <path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z" />
  </svg>
);
export const IconEye = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3l18 18M10.5 6.2A10 10 0 0112 6c6.5 0 10 6 10 6a17 17 0 01-3.2 3.7M6.6 6.6C3.7 8.4 2 12 2 12s3.5 6 10 6c1.6 0 3-.3 4.2-.9" />
  </svg>
);
export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </svg>
);
export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconMinus = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
);
export const IconUndo = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h9a6 6 0 010 12h-2" />
  </svg>
);
export const IconRedo = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9h-9a6 6 0 000 12h2" />
  </svg>
);
export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4v11m0 0l-4-4m4 4l4-4" />
    <path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" />
  </svg>
);
export const IconReset = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 10a8 8 0 1 1 2 6" />
    <path d="M4 4v6h6" />
  </svg>
);
export const IconInfo = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);
export const IconUpload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 16V5m0 0L8 9m4-4l4 4" />
    <path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)} strokeWidth={2.4}>
    <path d="M5 12l5 5L20 7" />
  </svg>
);

/* ---- Video Studio ---- */
export const IconPlay = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M7 5v14l12-7z" />
  </svg>
);
export const IconPause = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);
export const IconImage = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="2" />
    <path d="M21 16l-5-5-8 8" />
  </svg>
);
export const IconMic = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0014 0M12 18v3M8 21h8" />
  </svg>
);
export const IconType = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 6V4h14v2M12 4v16M9 20h6" />
  </svg>
);
export const IconFilm = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
  </svg>
);
export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 01-14.5 4.6M4 12a8 8 0 0114.5-4.6" />
    <path d="M20 4v4h-4M4 20v-4h4" />
  </svg>
);
export const IconUser = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0116 0" />
  </svg>
);
export const IconMusic = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 18V6l11-2v12" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="17" cy="16" r="3" />
  </svg>
);
export const IconGrid = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <rect x="3" y="10" width="18" height="4" rx="1" />
    <rect x="3" y="16" width="18" height="4" rx="1" />
  </svg>
);
export const IconBreak = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v18M5 8l3 4-3 4M19 8l-3 4 3 4" />
  </svg>
);
export const IconArrowUp = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
export const IconArrowDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12l7 7 7-7" />
  </svg>
);
export const IconCopy = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 012-2h9" />
  </svg>
);
/* ---- Voice Studio ---- */
export const IconWave = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 10v4M7 7v10M11 4v16M15 8v8M19 11v2" />
  </svg>
);
export const IconWand = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20l10-10M14 4l1.5 1.5M18 8l1.5 1.5M9 3l.7 2M20 13l-2 .7M15 8l4-4" />
  </svg>
);
/* ---- Face Swap ---- */
export const IconFaceSwap = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="9" r="4" />
    <path d="M2.5 20a5.5 5.5 0 0111 0" />
    <path d="M15 4.5h4.5V9M19.5 4.5L15 9M21 15h-4.5v4.5M16.5 15l4.5 4.5" />
  </svg>
);
