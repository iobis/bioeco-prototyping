FROM nginx:alpine

COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf

RUN mkdir -p /usr/share/nginx/html && echo '<!DOCTYPE html><html><body>Frontend not built. Use Vite dev server (frontend service) or build app and add dist to this image.</body></html>' > /usr/share/nginx/html/index.html
EXPOSE 80
