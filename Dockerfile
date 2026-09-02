FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=9000
EXPOSE 9000

CMD ["npm", "start"]
