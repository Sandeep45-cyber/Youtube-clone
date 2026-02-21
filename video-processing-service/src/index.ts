import express from 'express';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { Storage } from '@google-cloud/storage';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import fs from 'fs';
import os from 'os';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json({ limit: '10mb' }));

const storage = new Storage();
const firestore = new Firestore();

const videosCollection = process.env.FIRESTORE_VIDEOS_COLLECTION || 'videos';
const outputBucket = process.env.OUTPUT_BUCKET;
const jobToken = process.env.PUBSUB_VERIFICATION_TOKEN;
const renditionHeights = [360, 720];

type JobPayload = {
  videoId: string;
  inputBucket: string;
  inputObject: string;
  outputBucket?: string;
};

type PubSubBody = {
  message?: {
    data?: string;
  };
};

type RenditionInfo = {
  path: string;
  playbackUrl: string;
  height: number;
};

function parsePubSubPayload(body: PubSubBody): JobPayload {
  const encoded = body?.message?.data;
  if (!encoded) {
    throw new Error('Missing Pub/Sub message data');
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const payload = JSON.parse(decoded) as JobPayload;

  if (!payload.videoId || !payload.inputBucket || !payload.inputObject) {
    throw new Error('Job payload is missing required fields');
  }

  return payload;
}

async function updateVideoStatus(videoId: string, values: Record<string, unknown>) {
  const ref = firestore.collection(videosCollection).doc(videoId);
  await ref.set(
    {
      ...values,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

function transcodeToHeight(inputPath: string, outputPath: string, height: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-movflags +faststart'])
      .size(`?x${height}`)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.post('/process-video', async (req, res) => {
  try {
    if (jobToken) {
      const authHeader = req.header('authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      if (token !== jobToken) {
        return res.status(401).send('Unauthorized');
      }
    }

    const payload = parsePubSubPayload(req.body as PubSubBody);
    const targetBucket = payload.outputBucket || outputBucket;

    if (!targetBucket) {
      return res.status(500).send('OUTPUT_BUCKET is not configured');
    }

    const inputFileName = path.basename(payload.inputObject);
    const localInputPath = path.join(os.tmpdir(), `raw-${Date.now()}-${inputFileName}`);

    await updateVideoStatus(payload.videoId, {
      status: 'processing',
      rawPath: `gs://${payload.inputBucket}/${payload.inputObject}`,
    });

    await storage.bucket(payload.inputBucket).file(payload.inputObject).download({
      destination: localInputPath,
    });

    const renditions: Record<string, RenditionInfo> = {};
    const localOutputs: string[] = [];

    for (const height of renditionHeights) {
      const localOutputPath = path.join(
        os.tmpdir(),
        `processed-${payload.videoId}-${height}p-${Date.now()}.mp4`,
      );
      const outputObject = `processed/${payload.videoId}/${height}p.mp4`;

      await transcodeToHeight(localInputPath, localOutputPath, height);

      await storage.bucket(targetBucket).upload(localOutputPath, {
        destination: outputObject,
        contentType: 'video/mp4',
        metadata: {
          cacheControl: 'public, max-age=3600',
        },
      });

      const key = `${height}p`;
      renditions[key] = {
        path: `gs://${targetBucket}/${outputObject}`,
        playbackUrl: `https://storage.googleapis.com/${targetBucket}/${outputObject}`,
        height,
      };
      localOutputs.push(localOutputPath);
    }

    await updateVideoStatus(payload.videoId, {
      status: 'ready',
      renditions,
      processedPath: renditions['720p']?.path || renditions['360p']?.path,
      playbackUrl: renditions['720p']?.playbackUrl || renditions['360p']?.playbackUrl,
    });

    fs.rmSync(localInputPath, { force: true });
    localOutputs.forEach((output) => fs.rmSync(output, { force: true }));

    return res.status(200).send('processed');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const maybeVideoId = (() => {
      try {
        const payload = parsePubSubPayload(req.body as PubSubBody);
        return payload.videoId;
      } catch {
        return undefined;
      }
    })();

    if (maybeVideoId) {
      await updateVideoStatus(maybeVideoId, {
        status: 'failed',
        error: message,
      });
    }

    return res.status(500).send(`Processing failed: ${message}`);
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`Video processor listening on ${port}`);
});
