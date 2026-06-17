FROM node:18-alpine

# Buat direktori aplikasi
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy seluruh kode sumber
COPY . .

# Hugging Face Spaces secara otomatis mem-forward port 7860
EXPOSE 7860
ENV PORT=7860

# Jalankan aplikasi (index.js)
CMD ["npm", "start"]
