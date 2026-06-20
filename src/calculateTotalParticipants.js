/**
 * Calculate the total number of participants from a passenger list by summing three specific categories.
 *
 * @param {Object} passengerList - An object representing the passenger list with the following properties:
 *   - snorkeller {number} - Number of snorkellers (default to 0 if missing)
 *   - diving {number} - Number of divers (default to 0 if missing)
 *   - course {number} - Number of course participants (default to 0 if missing)
 *
 * @returns {number} The total sum of snorkeller + diving + course.
 *
 * @example
 * // Input:
 * const list = { snorkeller: 1, diving: 2, course: 3 };
 * calculateTotalParticipants(list); // Returns 6
 *
 * @example
 * // Input with missing fields:
 * const list = { snorkeller: 1 };
 * calculateTotalParticipants(list); // Returns 1 (other fields default to 0)
 *
 * @example
 * // Input with non-numeric values:
 * const list = { snorkeller: "1", diving: 2, course: 3 };
 * calculateTotalParticipants(list); // Throws TypeError: Values must be numbers.
 */
function calculateTotalParticipants(passengerList) {
  if (!passengerList || typeof passengerList !== 'object' || Array.isArray(passengerList)) {
    throw new TypeError('passengerList must be a non-null object');
  }

  const fields = ['snorkeller', 'diving', 'course'];
  let total = 0;

  for (const field of fields) {
    const value = passengerList[field];

    // Missing or undefined — default to 0
    if (value === undefined || value === null) {
      continue;
    }

    // Must be a valid number
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError(`Values must be numbers. Invalid value for "${field}": ${JSON.stringify(value)}`);
    }

    total += value;
  }

  return total;
}

module.exports = { calculateTotalParticipants };
