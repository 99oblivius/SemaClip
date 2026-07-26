import gsap from 'gsap';

/** Fade + slide in on mount. */
export function fadeIn(node: HTMLElement, opts?: { delay?: number; y?: number }) {
  const delay = opts?.delay ?? 0;
  const y = opts?.y ?? 8;
  gsap.from(node, { opacity: 0, y, duration: 0.4, delay, ease: 'power2.out' });
}

/** Stagger children fade-in. */
export function staggerIn(node: HTMLElement, opts?: { delay?: number; stagger?: number }) {
  const delay = opts?.delay ?? 0;
  const stagger = opts?.stagger ?? 0.05;
  const children = Array.from(node.children) as HTMLElement[];
  gsap.from(children, { opacity: 0, y: 8, duration: 0.3, delay, stagger, ease: 'power2.out' });
}

/** Slide up from bottom (for sheets/toasts). */
export function slideUp(node: HTMLElement, opts?: { delay?: number }) {
  const delay = opts?.delay ?? 0;
  gsap.from(node, { y: '100%', opacity: 0, duration: 0.3, delay, ease: 'power2.out' });
}

/** Key-light spotlight — dims sibling elements to focus attention. */
export function keyLight(node: HTMLElement) {
  const parent = node.parentElement;
  if (!parent) return;
  const siblings = Array.from(parent.children).filter((c) => c !== node) as HTMLElement[];
  gsap.to(siblings, { opacity: 0.4, duration: 0.2, ease: 'power2.inOut' });
  return {
    destroy() {
      gsap.to(siblings, { opacity: 1, duration: 0.2, ease: 'power2.inOut' });
    },
  };
}

/** Hover lift micro-interaction. */
export function hoverLift(node: HTMLElement) {
  const enter = () => gsap.to(node, { y: -2, duration: 0.15, ease: 'power1.out' });
  const leave = () => gsap.to(node, { y: 0, duration: 0.15, ease: 'power1.out' });
  node.addEventListener('mouseenter', enter);
  node.addEventListener('mouseleave', leave);
  return {
    destroy() {
      node.removeEventListener('mouseenter', enter);
      node.removeEventListener('mouseleave', leave);
    },
  };
}
