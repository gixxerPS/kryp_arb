function fmt2(n) {
  return Number(n).toFixed(2);
}

function fmt4(n) {
  return Number(n).toFixed(4);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

module.exports = {
  fmt2,
  fmt4,
  nowSec,
};

