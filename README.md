# Youtube Clone (GCP + Firebase)

This repository now contains a complete baseline implementation of the architecture you requested:

- Cloud Storage stores raw uploads and processed videos.
- Pub/Sub sends processing jobs.
- Cloud Run hosts a non-public video processing service.
- Firestore stores video metadata.
- Cloud Run hosts a Next.js web client.
- Firebase Functions expose APIs used by the web client.

## Repository Structure

- `video-processing-service`: Cloud Run processor that handles Pub/Sub push messages, transcodes videos with ffmpeg, uploads output to Storage, and updates Firestore.
- `firebase-functions`: API layer for listing videos, creating upload URLs, and queueing processing jobs.
- `web-client`: Next.js app with upload UI and video feed.

## 1) GCP Resources

Create the resources in your project (`PROJECT_ID`):

```bash
gcloud config set project PROJECT_ID

# Buckets
gsutil mb -l us-central1 gs://PROJECT_ID-raw-videos
gsutil mb -l us-central1 gs://PROJECT_ID-processed-videos

# Optional: public playback from processed bucket
# (for production, prefer signed URLs or CDN)
gsutil iam ch allUsers:objectViewer gs://PROJECT_ID-processed-videos

# Pub/Sub topic
gcloud pubsub topics create video-processing-jobs
```

Enable required APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  pubsub.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

## 2) Firestore Setup

Create Firestore in Native mode from the GCP console (or CLI if not already created).

Use collection: `videos`.

## 3) Deploy Video Processor (Cloud Run)

```bash
cd video-processing-service
npm install
npm run build

gcloud run deploy video-processor \
  --source . \
  --region us-central1 \
  --no-allow-unauthenticated \
  --set-env-vars OUTPUT_BUCKET=PROJECT_ID-processed-videos,FIRESTORE_VIDEOS_COLLECTION=videos
```

Grant processor service account access:

```bash
PROJECT_NUMBER=$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/datastore.user"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/storage.objectAdmin"
```

Create Pub/Sub push subscription to processor:

```bash
PROCESSOR_URL=$(gcloud run services describe video-processor --region us-central1 --format='value(status.url)')

gcloud pubsub subscriptions create video-processing-jobs-sub \
  --topic=video-processing-jobs \
  --push-endpoint="${PROCESSOR_URL}/process-video" \
  --push-auth-service-account="${RUN_SA}"
```

## 4) Deploy Firebase Functions

```bash
cd ../firebase-functions
npm install
```

Set function env via your deployment shell:

```bash
export FUNCTION_REGION=us-central1
export RAW_VIDEOS_BUCKET=PROJECT_ID-raw-videos
export PROCESSED_VIDEOS_BUCKET=PROJECT_ID-processed-videos
export VIDEO_PROCESSING_TOPIC=video-processing-jobs
export FIRESTORE_VIDEOS_COLLECTION=videos
```

Deploy:

```bash
npm run deploy
```

After deployment, note your API URL:

`https://us-central1-PROJECT_ID.cloudfunctions.net/api`

Grant function runtime permissions if needed:

- Firestore read/write
- Storage object admin for raw bucket (signed URL generation + object access)
- Pub/Sub publisher

## 5) Deploy Web Client (Cloud Run)

```bash
cd ../web-client
npm install
npm run build

gcloud run deploy youtube-web \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars NEXT_PUBLIC_FUNCTIONS_BASE_URL=https://us-central1-PROJECT_ID.cloudfunctions.net/api
```

## 6) Local Development

### Processor

```bash
cd video-processing-service
cp .env.example .env
npm install
npm run start
```

### Functions

```bash
cd firebase-functions
cp .env.example .env
npm install
npm run build
```

### Web Client

```bash
cd web-client
cp .env.example .env.local
npm install
npm run dev
```

## API Summary

Functions endpoint base: `/api`

- `GET /healthz`
- `GET /videos`
- `POST /videos`
  - body: `{ "title", "description", "filename", "contentType" }`
  - returns signed upload URL + video id
- `POST /videos/:videoId/process`
  - publishes Pub/Sub message to trigger processor

## Processing Job Payload (Pub/Sub)

```json
{
  "videoId": "abc123",
  "inputBucket": "PROJECT_ID-raw-videos",
  "inputObject": "raw/abc123-file.mp4",
  "outputBucket": "PROJECT_ID-processed-videos"
}
```

## Notes

- Processor outputs 360p MP4 (`processed/<videoId>.mp4`).
- Video metadata status flow: `uploading -> queued -> processing -> ready|failed`.
- For production security, replace public bucket playback with signed read URLs or CDN auth.
