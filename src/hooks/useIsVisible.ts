import { useEffect, useState, type RefObject } from 'react';

/**
 * Track whether an element is (near) the viewport.
 *
 * Used by the thumbnail rail and by continuous-scroll mode so that only the pages the
 * user can actually see get parsed and painted.
 */
export function useIsVisible<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: { rootMargin?: string } = {},
): boolean {
  const [visible, setVisible] = useState(false);
  const rootMargin = options.rootMargin ?? '600px 0px';

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { root: null, rootMargin, threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin]);

  return visible;
}
