'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchVideo, preferredPlaybackUrl, type Video } from '@/lib/api';

export default function WatchPage() {
  const params = useParams<{ id: string }>();
  const videoId = params?.id;
  const [video, setVideo] = useState<Video | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!videoId) {
      return;
    }

    fetchVideo(videoId)
      .then((value) => {
        setVideo(value);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load video');
      });
  }, [videoId]);

  if (error) {
    return (
      <main>
        <p>{error}</p>
        <Link href="/">Back to home</Link>
      </main>
    );
  }

  if (!video) {
    return (
      <main>
        <p>Loading video...</p>
      </main>
    );
  }

  const playback = preferredPlaybackUrl(video);

  return (
    <main>
      <Link className="watch-link" href="/">
        Back to home
      </Link>
      <h1>{video.title}</h1>
      {video.description ? <p>{video.description}</p> : null}
      <span className="status">{video.status}</span>
      {playback ? <video controls src={playback} preload="metadata" /> : <p>Video is still processing.</p>}
    </main>
  );
}
