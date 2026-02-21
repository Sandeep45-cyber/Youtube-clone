'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { auth, googleProvider } from '@/lib/firebase';
import { createUploadSession, fetchVideos, preferredPlaybackUrl, uploadVideo, type Video } from '@/lib/api';

export default function HomePage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasFirebaseAuth = Boolean(auth && googleProvider);

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
    if (!auth) {
      setAuthReady(true);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    loadVideos().catch(() => undefined);
    const timer = window.setInterval(() => {
      loadVideos().catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user) {
      setError('Sign in with Google to upload videos.');
      return;
    }

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
      const idToken = await user.getIdToken();
      const { uploadUrl } = await createUploadSession(
        {
          title,
          description,
          filename: file.name,
          contentType: file.type || 'video/mp4',
        },
        idToken,
      );

      await uploadVideo(uploadUrl, file);
      form.reset();
      await loadVideos();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload flow failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignIn() {
    if (!auth || !googleProvider) {
      setError('Firebase Auth config is missing.');
      return;
    }

    try {
      await signInWithPopup(auth, googleProvider);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in');
    }
  }

  async function handleSignOut() {
    if (!auth) {
      return;
    }
    await signOut(auth);
  }

  return (
    <main>
      <h1>Youtube Clone</h1>
      <p>Signed-in users can upload videos. Processing runs asynchronously via Storage, Pub/Sub, and Cloud Run.</p>

      <section className="card auth-row">
        {authReady && user ? (
          <>
            <p>Signed in as {user.email}</p>
            <button type="button" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        ) : (
          <button type="button" onClick={handleSignIn} disabled={!authReady || !hasFirebaseAuth}>
            Sign in with Google
          </button>
        )}
      </section>
      {!hasFirebaseAuth ? <p>Set Firebase web env vars to enable authentication.</p> : null}

      <section className="card">
        <h2>Upload Video</h2>
        <form onSubmit={onSubmit}>
          <input type="text" name="title" placeholder="Video title" required />
          <textarea name="description" placeholder="Description" rows={3} />
          <input type="file" name="video" accept="video/*" required />
          <button disabled={submitting || !user} type="submit">
            {submitting ? 'Uploading...' : user ? 'Upload Video' : 'Sign in to Upload'}
          </button>
        </form>
        {error ? <p>{error}</p> : null}
      </section>

      <section className="video-grid">
        {loading ? <p>Loading videos...</p> : null}
        {!loading && videos.length === 0 ? <p>No videos yet.</p> : null}
        {videos.map((video) => {
          const playback = preferredPlaybackUrl(video);
          return (
            <article className="card" key={video.id}>
              <h3>{video.title}</h3>
              {video.description ? <p>{video.description}</p> : null}
              <span className="status">{video.status}</span>
              {video.status === 'ready' && playback ? (
                <>
                  <video controls src={playback} preload="metadata" />
                  <Link className="watch-link" href={`/watch/${video.id}`}>
                    Open video page
                  </Link>
                </>
              ) : null}
              {video.status === 'failed' && video.error ? <p>{video.error}</p> : null}
            </article>
          );
        })}
      </section>
    </main>
  );
}
