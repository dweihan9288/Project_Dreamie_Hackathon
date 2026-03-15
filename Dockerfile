# Build stage
FROM node:20-alpine as build
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the Vite React app
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy the built assets from the build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Configure Nginx to serve the SPA (Single Page Application) correctly
# This routes all requests to index.html so React Router can handle them
RUN echo 'server { \
    listen 8080; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html; \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Expose the port Cloud Run expects
EXPOSE 8080

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
