# Dreamie

Dreamie is a mobile-first web application designed to help users with ADHD overcome executive dysfunction by turning mundane chores into epic, immersive quests based on their personal daydreams.

## 🚀 Spin-up Instructions (Local Development)

Follow these step-by-step instructions to set up and run the project locally. This proves the project is fully reproducible.

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn
- A Gemini API Key (Get one at [Google AI Studio](https://aistudio.google.com/))
- Firebase Project (Firestore & Auth enabled)

### 1. Clone the repository
```bash
git clone <your-repo-url>
cd dreamie
```

### 2. Install dependencies
```bash
npm install
```

### 3. Environment Variables
Copy the `.env.example` file to create a `.env` file:
```bash
cp .env.example .env
```
Open the `.env` file and add your `GEMINI_API_KEY`. 

### 4. Run the development server
```bash
npm run dev
```
The app will be available at `http://localhost:3000` (or the port specified in your terminal).

---

## ☁️ Cloud Deployment (Google Cloud Run)

This project includes automated deployment scripts to prove infrastructure-as-code practices, fulfilling the hackathon automation requirements.

### Automated Deployment via Cloud Build (CI/CD)
1. Connect your GitHub repository to Google Cloud Build.
2. Set up a trigger to run on pushes to the `main` branch.
3. Cloud Build will automatically use the `cloudbuild.yaml` file to build the Docker image and deploy it to Cloud Run.

### Manual Deployment via gcloud CLI
If you prefer to trigger the deployment manually using the provided configuration:
```bash
gcloud builds submit --config cloudbuild.yaml
```

---

## 🧪 Testing Credentials for Judges

To test the live application without creating an account, please use the following credentials:
- **Email:** `judge@test.com`
- **Password:** `password123`

*(Note to developer: Ensure you create this account in your Firebase Auth console before submitting!)*
