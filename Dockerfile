FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
RUN printf '%s\n' 'server {' '    listen 10000;' '    listen [::]:10000;' '    server_name _;' '    root /usr/share/nginx/html;' '    index index.html;' '    location / {' '        try_files $uri $uri/ =404;' '    }' '}' > /etc/nginx/conf.d/default.conf
EXPOSE 10000
CMD ["nginx", "-g", "daemon off;"]
