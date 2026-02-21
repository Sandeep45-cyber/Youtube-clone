# Youtube Clone (Skeleton Design Implementation)

This repo implements the simplified YouTube architecture with Firebase + GCP:

- Firebase Auth (Google sign in/out)
- Cloud Storage (raw + processed videos)
- Cloud Pub/Sub (upload event queue)
- Cloud Run video processor (ffmpeg)
- Firestore metadata storage
- Firebase Functions API + triggers
- Next.js web client on Cloud Run

## Architecture

Upload path:

1. User signs in via Google on web client.
2. Web client requests a signed upload URL from Firebase Functions (`POST /videos`) with Firebase ID token.
3. Video uploads directly to raw Cloud Storage bucket.
4. Storage finalize trigger (`onRawVideoUploaded`) publishes a Pub/Sub processing message.
5. Pub/Sub push subscription calls non-public Cloud Run processor (`/process-video`).
6. Processor transcodes to 360p + 720p and uploads to processed bucket.
7. Processor updates Firestore video metadata (`status`, `renditions`, playback URLs).
8. Web client reads metadata through Functions (`GET /videos`, `GET /videos/:id`).

## Repository Structure

- `video-processing-service`: Cloud Run processor worker
- `firebase-functions`: API + Firebase Auth/Storage triggers
- `web-client`: Next.js client

## Core Features Implemented

- Google sign in/out from Next.js client
- Auth-protected video upload URL generation
- Automatic user profile doc creation in Firestore (`users` collection)
- Automatic processing queueing on raw upload finalize event
- Manual requeue endpoint (`POST /videos/:videoId/process`) for retry/admin use
- Multi-resolution transcoding (`360p`, `720p`)
- Public video listing and single video endpoints
- Home feed + individual video page (`/watch/[id]`)

## Setup

Set your project:

```bash
gcloud config set project PROJECT_ID
```

Enable APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  pubsub.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  cloudfunctions.googleapis.com \
  firebase.googleapis.com
```

Create buckets and topic:

```bash
gsutil mb -l us-central1 gs://PROJECT_ID-raw-videos
gsutil mb -l us-central1 gs://PROJECT_ID-processed-videos
gcloud pubsub topics create video-processing-jobs
```

For demo playback, make processed videos public:

```bash
gsutil iam ch allUsers:objectViewer gs://PROJECT_ID-processed-videos
```

Create Firestore database (Native mode) if not created.

## Deploy Video Processor (Cloud Run)

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

Grant processor runtime SA access:

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

## Deploy Firebase Functions

```bash
cd ../firebase-functions
npm install
```

Set environment variables in shell before deploy:

```bash
export FUNCTION_REGION=us-central1
export RAW_VIDEOS_BUCKET=PROJECT_ID-raw-videos
export PROCESSED_VIDEOS_BUCKET=PROJECT_ID-processed-videos
export VIDEO_PROCESSING_TOPIC=video-processing-jobs
export FIRESTORE_VIDEOS_COLLECTION=videos
export FIRESTORE_USERS_COLLECTION=users
```

Deploy:

```bash
npm run deploy
```

Functions deployed include:

- `api` (HTTP)
- `onRawVideoUploaded` (Storage finalize trigger)
- `createUserProfile` (Auth user-created trigger)

## Deploy Web Client (Cloud Run)

`web-client/.env.example` documents required Firebase web config keys.

Deploy:

```bash
cd ../web-client
npm install
npm run build

gcloud run deploy youtube-web \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars NEXT_PUBLIC_FUNCTIONS_BASE_URL=https://us-central1-PROJECT_ID.cloudfunctions.net/api,NEXT_PUBLIC_FIREBASE_API_KEY=...,NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...,NEXT_PUBLIC_FIREBASE_PROJECT_ID=...,NEXT_PUBLIC_FIREBASE_APP_ID=...
```

## API Endpoints

- `GET /healthz`
- `GET /videos`
- `GET /videos/:videoId`
- `POST /videos` (auth required)
- `POST /videos/:videoId/process` (auth required)

## Firestore Video Status Flow

`uploading -> queued -> processing -> ready | failed`

When `ready`, `renditions` is stored like:

```json
{
  "360p": { "path": "gs://...", "playbackUrl": "https://...", "height": 360 },
  "720p": { "path": "gs://...", "playbackUrl": "https://...", "height": 720 }
}
```

## Notes

- Cloud Run request max timeout is 3600s.
- Pub/Sub push retries and redelivery apply for failed processing requests.
- Content moderation and legal-content checks are not implemented.
