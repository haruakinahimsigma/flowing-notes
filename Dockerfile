FROM nginx:alpine

# Serve the Flowing Notes single-page app on Render's default web-service port.
COPY index.html /usr/share/nginx/html/index.html

RUN printf '%s\n' \
  'server {' \
  '    listen 10000;' \
  '    listen [::]:10000;' \
  '    server_name _;' \
  '    root /usr/share/nginx/html;' \
  '    index index.html;' \
  '    location / {' \
  '        try_files $uri $uri/ =404;' \
  '    }' \
  '}' > /etc/nginx/conf.d/default.conf

EXPOSE 10000

CMD ["nginx", "-g", "daemon off;"]
