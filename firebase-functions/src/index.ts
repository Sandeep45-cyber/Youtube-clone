import express, { Request, Response } from 'express';
import cors from 'cors';
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import admin from 'firebase-admin';
import { Storage } from '@google-cloud/storage';
import { PubSub } from '@google-cloud/pubsub';

admin.initializeApp();

const firestore = admin.firestore();
const storage = new Storage();
const pubsub = new PubSub();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const collection = process.env.FIRESTORE_VIDEOS_COLLECTION || 'videos';
const rawBucket = process.env.RAW_VIDEOS_BUCKET;
const outputBucket = process.env.PROCESSED_VIDEOS_BUCKET;
const processingTopic = process.env.VIDEO_PROCESSING_TOPIC;

type CreateVideoBody = {
  title: string;
  description?: string;
  filename: string;
  contentType?: string;
};

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/videos', async (_req: Request, res: Response) => {
  const snapshot = await firestore
    .collection(collection)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();

  const videos = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  res.status(200).json({ videos });
});

app.post('/videos', async (req: Request<unknown, unknown, CreateVideoBody>, res: Response) => {
  if (!rawBucket) {
    return res.status(500).json({ error: 'RAW_VIDEOS_BUCKET is not configured' });
  }

  const { title, description, filename, contentType } = req.body;

  if (!title || !filename) {
    return res.status(400).json({ error: 'title and filename are required' });
  }

  const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const videoRef = firestore.collection(collection).doc();
  const objectPath = `raw/${videoRef.id}-${safeFilename}`;

  await videoRef.set({
    title,
    description: description || '',
    rawPath: `gs://${rawBucket}/${objectPath}`,
    status: 'uploading',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const [uploadUrl] = await storage.bucket(rawBucket).file(objectPath).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000,
    contentType: contentType || 'video/mp4',
  });

  return res.status(201).json({
    videoId: videoRef.id,
    uploadUrl,
    objectPath,
    bucket: rawBucket,
  });
});

app.post('/videos/:videoId/process', async (req: Request<{ videoId: string }>, res: Response) => {
  if (!rawBucket || !processingTopic) {
    return res.status(500).json({ error: 'RAW_VIDEOS_BUCKET or VIDEO_PROCESSING_TOPIC is missing' });
  }

  const { videoId } = req.params;
  const videoRef = firestore.collection(collection).doc(videoId);
  const snapshot = await videoRef.get();

  if (!snapshot.exists) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const video = snapshot.data() as { rawPath?: string } | undefined;
  const rawPath = video?.rawPath;

  if (!rawPath || !rawPath.startsWith(`gs://${rawBucket}/`)) {
    return res.status(400).json({ error: 'Invalid rawPath on video metadata' });
  }

  const objectPath = rawPath.replace(`gs://${rawBucket}/`, '');

  await videoRef.set(
    {
      status: 'queued',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const payload = {
    videoId,
    inputBucket: rawBucket,
    inputObject: objectPath,
    outputBucket,
  };

  await pubsub.topic(processingTopic).publishMessage({
    data: Buffer.from(JSON.stringify(payload)),
  });

  return res.status(200).json({ queued: true, videoId });
});

app.use((err: Error, _req: Request, res: Response, _next: unknown) => {
  logger.error(err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

export const api = onRequest(
  {
    region: process.env.FUNCTION_REGION || 'us-central1',
    cors: true,
    memory: '512MiB',
    timeoutSeconds: 120,
  },
  app,
);
