'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  createUploadSession,
  fetchVideos,
  queueVideoProcessing,
  uploadVideo,
  type Video,
} from '@/lib/api';

export default function HomePage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadVideos() {
    setLoading(true);
    try {
      const data = await fetchVideos();
      setVideos(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load videos');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadVideos().catch(() => undefined);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const title = String(formData.get('title') || '').trim();
    const description = String(formData.get('description') || '').trim();
    const file = formData.get('video') as File | null;

    if (!file || file.size === 0) {
      setError('Please choose a video file');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const { videoId, uploadUrl } = await createUploadSession({
        title,
        description,
        filename: file.name,
        contentType: file.type || 'video/mp4',
      });

      await uploadVideo(uploadUrl, file);
      await queueVideoProcessing(videoId);
      form.reset();
      await loadVideos();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload flow failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Youtube Clone</h1>
      <p>Upload a video, process it in Cloud Run, and stream from Cloud Storage.</p>

      <section className="card">
        <h2>Upload Video</h2>
        <form onSubmit={onSubmit}>
          <input type="text" name="title" placeholder="Video title" required />
          <textarea name="description" placeholder="Description" rows={3} />
          <input type="file" name="video" accept="video/*" required />
          <button disabled={submitting} type="submit">
            {submitting ? 'Uploading...' : 'Upload and Process'}
          </button>
        </form>
        {error ? <p>{error}</p> : null}
      </section>

      <section className="video-grid">
        {loading ? <p>Loading videos...</p> : null}
        {!loading && videos.length === 0 ? <p>No videos yet.</p> : null}
        {videos.map((video) => (
          <article className="card" key={video.id}>
            <h3>{video.title}</h3>
            {video.description ? <p>{video.description}</p> : null}
            <span className="status">{video.status}</span>
            {video.status === 'ready' && video.playbackUrl ? (
              <video controls src={video.playbackUrl} preload="metadata" />
            ) : null}
            {video.status === 'failed' && video.error ? <p>{video.error}</p> : null}
          </article>
        ))}
      </section>
    </main>
  );
}
