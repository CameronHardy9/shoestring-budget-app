/** Shoestring mark: a lace forming an "S". Decorative; text names the app. */
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" className="fill-brand" />
      <path
        d="M21.5 10.5c-1.3-1.2-3.1-1.8-5.2-1.8-3.1 0-5.1 1.6-5.1 3.8 0 4.8 10.6 2.7 10.6 7.3 0 2.2-2.1 3.9-5.5 3.9-2.3 0-4.3-.7-5.8-2.1"
        fill="none"
        strokeWidth="2.6"
        strokeLinecap="round"
        className="stroke-on-brand"
      />
    </svg>
  );
}
