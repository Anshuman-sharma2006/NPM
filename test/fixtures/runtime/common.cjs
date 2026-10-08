const { child } = require('./helper.cjs');

function parent() {
  return child();
}

parent();
