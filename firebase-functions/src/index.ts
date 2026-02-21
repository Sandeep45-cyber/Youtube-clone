import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { onRequest } from 'firebase-functions/v2/https';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { logger } from 'firebase-functions';
import { user } from 'firebase-functions/v1/auth';
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
const usersCollection = process.env.FIRESTORE_USERS_COLLECTION || 'users';
const rawBucket = process.env.RAW_VIDEOS_BUCKET;
const outputBucket = process.env.PROCESSED_VIDEOS_BUCKET;
const processingTopic = process.env.VIDEO_PROCESSING_TOPIC;
const functionRegion = process.env.FUNCTION_REGION || 'us-central1';

type CreateVideoBody = {
  title: string;
  description?: string;
  filename: string;
  contentType?: string;
};

type AuthenticatedRequest = Request & {
  user?: admin.auth.DecodedIdToken;
};

function parseVideoIdFromRawObject(name: string): string | undefined {
  const match = name.match(/^raw\/([^/]+?)-/);
  return match?.[1];
}

async function publishProcessingJob(input: {
  videoId: string;
  inputBucket: string;
  inputObject: string;
}) {
  if (!processingTopic) {
    throw new Error('VIDEO_PROCESSING_TOPIC is missing');
  }

  const payload = {
    videoId: input.videoId,
    inputBucket: input.inputBucket,
    inputObject: input.inputObject,
    outputBucket,
  };

  await pubsub.topic(processingTopic).publishMessage({
    data: Buffer.from(JSON.stringify(payload)),
  });
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.header('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  try {
    req.user = await admin.auth().verifyIdToken(token);
    return next();
  } catch (error) {
    logger.warn('Token verification failed', error);
    return res.status(401).json({ error: 'Invalid auth token' });
  }
}

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/videos', async (_req: Request, res: Response) => {
  const snapshot = await firestore.collection(collection).orderBy('createdAt', 'desc').limit(100).get();

  const videos = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  res.status(200).json({ videos });
});

app.get('/videos/:videoId', async (req: Request<{ videoId: string }>, res: Response) => {
  const snapshot = await firestore.collection(collection).doc(req.params.videoId).get();
  if (!snapshot.exists) {
    return res.status(404).json({ error: 'Video not found' });
  }

  return res.status(200).json({
    video: {
      id: snapshot.id,
      ...snapshot.data(),
    },
  });
});

app.post('/videos', requireAuth, async (req: Request<unknown, unknown, CreateVideoBody>, res: Response) => {
  if (!rawBucket) {
    return res.status(500).json({ error: 'RAW_VIDEOS_BUCKET is not configured' });
  }

  const authReq = req as AuthenticatedRequest;
  const user = authReq.user;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
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
    uploadedBy: user.uid,
    uploaderEmail: user.email || '',
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

app.post(
  '/videos/:videoId/process',
  requireAuth,
  async (req: Request<{ videoId: string }>, res: Response) => {
    if (!rawBucket) {
      return res.status(500).json({ error: 'RAW_VIDEOS_BUCKET is not configured' });
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

    await publishProcessingJob({
      videoId,
      inputBucket: rawBucket,
      inputObject: objectPath,
    });

    return res.status(200).json({ queued: true, videoId });
  },
);

app.use((err: Error, _req: Request, res: Response, _next: unknown) => {
  logger.error(err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

export const api = onRequest(
  {
    region: functionRegion,
    cors: true,
    memory: '512MiB',
    timeoutSeconds: 120,
  },
  app,
);

export const onRawVideoUploaded = onObjectFinalized({ region: functionRegion }, async (event) => {
  try {
    if (!rawBucket) {
      logger.warn('RAW_VIDEOS_BUCKET is not configured');
      return;
    }

    const bucket = event.data.bucket;
    const name = event.data.name;

    if (!bucket || !name || bucket !== rawBucket || !name.startsWith('raw/')) {
      return;
    }

    let videoId = parseVideoIdFromRawObject(name);

    if (!videoId) {
      const rawPath = `gs://${bucket}/${name}`;
      const querySnapshot = await firestore
        .collection(collection)
        .where('rawPath', '==', rawPath)
        .limit(1)
        .get();

      if (querySnapshot.empty) {
        logger.warn('No video metadata found for uploaded object', { rawPath });
        return;
      }

      videoId = querySnapshot.docs[0].id;
    }

    const videoRef = firestore.collection(collection).doc(videoId);
    const videoSnapshot = await videoRef.get();
    if (!videoSnapshot.exists) {
      logger.warn('Video document missing during storage finalize', { videoId, name });
      return;
    }

    const currentStatus = (videoSnapshot.data() as { status?: string } | undefined)?.status;
    if (currentStatus === 'queued' || currentStatus === 'processing' || currentStatus === 'ready') {
      return;
    }

    await videoRef.set(
      {
        status: 'queued',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await publishProcessingJob({
      videoId,
      inputBucket: bucket,
      inputObject: name,
    });

    logger.info('Queued processing job from storage finalize event', { videoId, name });
  } catch (error) {
    logger.error('Failed to queue job from storage finalize', error);
  }
});

export const createUserProfile = user().onCreate(async (userRecord) => {
  if (!userRecord.uid) {
    return;
  }

  const userRef = firestore.collection(usersCollection).doc(userRecord.uid);
  await userRef.set(
    {
      email: userRecord.email || '',
      displayName: userRecord.displayName || '',
      photoURL: userRecord.photoURL || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
});
