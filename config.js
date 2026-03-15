// ===== TIMEZONE CONFIGURATION =====
const CONFIG = {
  TIMEZONE: 'Asia/Baghdad',
  TIMEZONE_OFFSET: 3,
  TIME_FORMAT: 'HH:mm', 
  DATE_FORMAT: 'DD/MM/YYYY'
};

function getTimeWithTimezone() {
  const now = new Date();
  const baghdadTime = new Date(now.toLocaleString('en-US', { 
    timeZone: 'Asia/Baghdad' 
  }));
  
  const hours = String(baghdadTime.getHours()).padStart(2, '0');
  const minutes = String(baghdadTime.getMinutes()).padStart(2, '0');
  
  return `${hours}:${minutes}`;
}

function getFullDateWithTimezone() {
  const now = new Date();
  const baghdadTime = new Date(now.toLocaleString('en-US', { 
    timeZone: 'Asia/Baghdad' 
  }));
  
  const day = String(baghdadTime.getDate()).padStart(2, '0');
  const month = String(baghdadTime.getMonth() + 1).padStart(2, '0');
  const year = baghdadTime.getFullYear();
  
  return `${day}/${month}/${year}`;
}

function getFullDateTime() {
  return `${getFullDateWithTimezone()} ${getTimeWithTimezone()}`;
}

module.exports = {
  CONFIG,
  getTimeWithTimezone,
  getFullDateWithTimezone,
  getFullDateTime
};
