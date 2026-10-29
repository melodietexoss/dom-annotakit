/**
 * dom-annotakit — inline SVG icons (COPY-MAP manager row: `@storybook/icons`
 * → local module; the SB package is not a dependency here).
 *
 * Same export names + (width, height) prop shape as the SB originals the
 * panel/toolbar consumed — stroke-based 16×16 viewBox glyphs.
 */
import React from 'react';

export interface IconProps {
  width?: number;
  height?: number;
}

const svg = (path: React.ReactNode, extra?: Record<string, string>): React.FC<IconProps> => {
  const C: React.FC<IconProps> = ({ width = 14, height = 14 }) => (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...extra}
    >
      {path}
    </svg>
  );
  C.displayName = 'Icon';
  return C;
};

export const PinIcon = svg(
  <>
    <path d="M9.5 2.5a3.5 3.5 0 0 1 4 4L8 12l-2.5 1L4 14l1-1.5L2 8l5.5-5.5Z" />
    <circle cx="10.5" cy="5.5" r="0.75" fill="currentColor" stroke="none" />
  </>,
);

export const BoxIcon = svg(
  <>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1" strokeDasharray="2.5 2" />
  </>,
);

export const CameraIcon = svg(
  <>
    <path d="M2 6.5A1.5 1.5 0 0 1 3.5 5h1l1-1.5h5L11.5 5h1A1.5 1.5 0 0 1 14 6.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-5Z" />
    <circle cx="8" cy="9" r="2.25" />
  </>,
);

export const CheckIcon = svg(
  <>
    <path d="M3 8.5 6.25 11.75 13 4.5" />
  </>,
);

export const CommentIcon = svg(
  <>
    <path d="M14 8a5.5 5.5 0 0 1-5.5 5.5c-.9 0-1.75-.17-2.5-.5L3 14l1-3c-.33-.75-.5-1.6-.5-2.5A5.5 5.5 0 0 1 8.5 2.5h.5A5.5 5.5 0 0 1 14 8Z" transform="translate(-1 -1)" />
  </>,
);

export const CommentsIcon = svg(
  <>
    <path d="M10.5 2.5H4A2.5 2.5 0 0 0 1.5 5v3A2.5 2.5 0 0 0 4 10.5V13l3-2.5h3.5A2.5 2.5 0 0 0 13 8V5a2.5 2.5 0 0 0-2.5-2.5Z" />
    <path d="M13.5 6.5A2.5 2.5 0 0 1 15 8.8v2.7a2.5 2.5 0 0 1-2.5 2.5H11" opacity="0.55" />
  </>,
);

export const EyeIcon = svg(
  <>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2.25" />
  </>,
);

export const EyeCloseIcon = svg(
  <>
    <path d="M2.5 5.5C1.8 6.4 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1 0 1.9-.25 2.7-.65M6.1 4.05C6.7 3.7 7.3 3.5 8 3.5c4 0 6.5 4.5 6.5 4.5s-.55 1.02-1.5 2" />
    <path d="M2 2l12 12" />
  </>,
);

export const LinkIcon = svg(
  <>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M10.75 3.75a2.12 2.12 0 0 1 3 3l-1.5 1.5a2.12 2.12 0 0 1-3-3Z" />
    <path d="M5.25 12.25a2.12 2.12 0 0 1-3-3l1.5-1.5a2.12 2.12 0 0 1 3 3Z" />
  </>,
);

export const SyncIcon = svg(
  <>
    <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9M2.5 8a5.5 5.5 0 0 1 9.4-3.9" />
    <path d="M12.5 12.5v-3.5h-3.5M3.5 3.5V7H7" />
  </>,
);

/* D9: the dark-mode toggle glyphs (moon = switch to dark, sun = switch to light). */
export const MoonIcon = svg(
  <>
    <path d="M13.2 9.5A5.5 5.5 0 0 1 6.5 2.8 5.5 5.5 0 1 0 13.2 9.5Z" />
  </>,
);

export const SunIcon = svg(
  <>
    <circle cx="8" cy="8" r="3.2" />
    <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" />
  </>,
);
