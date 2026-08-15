# Preinstalled Chromium + system libs — avoids Render native build hang
# after downloading ~161MB Playwright browsers.
FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV TVAM_HEADLESS=true
# Must match playwright package version (browsers preinstalled in this image)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN npm install --omit=dev --no-package-lock

COPY . .

# Render Web Services require a process listening on $PORT.
# The worker starts an HTTP health endpoint + job poll loop.
EXPOSE 10000
CMD ["npm", "start"]
