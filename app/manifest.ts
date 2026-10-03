import type { MetadataRoute } from 'next'

/* Installable to a phone's home screen or a desktop dock, opening without
   browser chrome. The shortcuts are the two places capture lands. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Meeting Manager',
    short_name: 'Meetings',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f9fafb',
    theme_color: '#2563eb',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Inbox', url: '/inbox', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Meetings', url: '/meetings', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  }
}
