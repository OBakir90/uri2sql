// Module uri2sql.js
//
// The purpose of this module is to take an HTTP query string and
// convert it into a piece of SQL comprising a WHERE clause along
// with optional ORDER BY and other clauses.
//
// Once converted the SQL piece can be appended to an SQL query
// to filter the result set according to client requiremnents.
//
// Author:  Keith Bremer
// License: LGPL-3.0 (GNU Lesser General Public License, version 3)
// Release 0.1 (Alpha)
//
var subs = "$";       // set for PostgreSQL, use : for Oracle

function setsubs(symbol) {
  //
  // Function to change the bind variable placeholder symbol
  //
  subs = symbol;
}

function uri2sql(query, columns) {
  //
  // Function to generate an SQL predicate (WHERE clause) from an HTTP query
  // as supplied as part of the URI for an endpoint.
  // e.g. http://localhost:3000/customers?name[like]=%Jones&city=Paris
  // should produce:
  // WHERE name LIKE '%Jones' AND city = 'Paris'
  //
  // Syntax of query (following ? in the URI):
  // column=value
  // column[operator]=value
  // column[operator]=value:value:value...
  // column[-operator]=value...
  //
  // column   = name of the column in the table
  // operator = text form of a comparison operator from the following:
  //            '=' '!=' '<' '<=' '>' '>=' 'in' 'like' 'tween' 'is'
  //            the operator may be negated by prefixing with - (minus)
  // value    = a string or number or the text NULL (in upper case)
  //            for operators 'twixt' and 'in' there may be a colon-separated
  //            list of values (two for 'tween' and one or more for 'in')
  //
  // The query argument to this function is the result of using body-parser
  // to convert the URI query into JSON, so the above example would be supplied
  // as:
  // { name: {like: "%Jones"}, city: "Paris" }
  //
  
    function getValue(param) {
      //
      // Get the value part of an object's attribute in a form suitable for SQL
      // (Only NULL, strings (including date/time) and numbers are recognised at present)
      // String values are minimally sanitised (refusing any that contain ' or ;)
      //
      if (param.length == 0) {
        throw "ERROR: missing value parameter"      // no value supplied so error
      };

      var n = new Number(param);              // try a number?
      if (n instanceof Number && !isNaN(n)) { // warning - double negative!
        return n;                             // it is a number so return that
      } else if (param == "NULL") {
        return param                          // it is NULL
      } else if (typeof(param) == "string") { // if it's a string then...
        if (param.includes("'") || param.includes(";")) {   // sanitise it...
          throw "ERROR: invalid value in query: " + param;  // and reject if invalid
        }
        return param;                         // just return the value
      }
    }     // end of getValue function

    function checkCol(colName) {
      //
      // Check column name is valid in the array of column names provided.
      // If no column names are supplied then ignore these checks, otherwise
      // throw an exception if not found.
      //
      if (columns.length > 0) {   // if the column array is provided check the name
        if (columns.find(o => o.column_name == colName) == undefined) { 
          throw "ERROR: invalid column name: " + colName;
        };
      }
    }

    //
    // The valid operators allowed in http queries (within [...] after the column name)
    // 
    var operators = ['eq', 'ne', 'lt', 'gte', 'gt', 'lte', 'in', 'like', 'tween', 'is'];
    //
    // The SQL operators that correspond to the http query operators above, as two arrays
    // within an array.  The first [0] is the normal translation, the second [1] is the
    // negated translation
    //
    var sqlop = [
          // normal translation...
        ['= ', '!= ', '< ', '>= ', '> ', '<= ', 'IN (', 'LIKE ', 'BETWEEN ', 'IS '],
          // negated translation...
        ['!= ', '= ', '>= ', '< ', '<= ', '> ', 'NOT IN (', 'NOT LIKE ', 'NOT BETWEEN ', 'IS NOT ']
    ];

    var sql = "";                 // initial sql string
    var sort = "";                // initial order by string
    var valueArray = [];          // initial value array
    var substitution = 1;         // number for $n bind placeholder

    //
    // Loop through each query parameter (separated in URI by &) and translate
    // into corresponding SQL predicate syntax. Each new predicate is appended
    // to the previous ones with AND.
    //
    for (var col in query) {        // for each query parameter (introduced by column name)

      var typ = typeof(query[col]);     // get the type of the value

      if (col.charAt(0) == "$") {   // $ = special symbol, not a columns name
        //
        // Special symbol processing:
        //
        if (col == "$sort") {       
          //
          // Syntax:
          //    $sort=col             sort results by column
          //    $sort=col1:col2:...   sort results by col1, col2, etc.
          //    $sort=-col1:col2      sort results by col1 desc, col2 asc
          //
          if (typ != "string") {
            throw "ERROR: incorrect $sort parameter value: " + query[col];
          }
          //
          // get an array of sort columns & process each...
          //
          var sortCols = getValue(query[col]).split(":");

          sortCols.forEach( (sortCol) => {
            let sortDir = "";           // sort direction: initially default
            if (sortCol.charAt(0) == "-") {   // is sort negated?
              sortDir = " DESC";              // if so then direction = DESC
              sortCol = sortCol.substring(1); // remove leading "-"
            }
            checkCol(sortCol);          // check the column name
            //
            // Construct the ORDER BY clause
            //
            if (sort == "") {
              sort = "ORDER BY ";       // start with ORDER BY
            } else {
              sort = sort + ", ";       // add more after comma
            }
            sort = sort + sortCol + sortDir;  // add column & direction
          });   // end of sortCols.foreach...
        }     // end of 'if (col == "$sort") ...'
      } else {
        //
        // Filter condition processing
        //
        checkCol(col);

        var negate = 0;             // initially assume un-negated operator
        //
        // Handle the appending of code to the sql and deal with the case
        // of no operator (assumes 'eq' be default)
        //
        if (sql == "") {
          sql = sql + "WHERE ";     // this must be the 1st parameter
        } else {
          sql = sql + "AND ";       // if not 1st parameter add AND keyword
        }
        sql = sql + col + " ";      // append column name

        //
        // If the datatype of the value isn't an object then treat it as a
        // simple value.  Add a bind variable to the sql (e.g. $3) and push
        // the value onto the array.
        //
        if (typ != "object") {            // not an object so no operator provided
          sql = sql + "= " + subs + (substitution++) + " ";    // so assume eq (=)
          val = getValue(query[col]);     // get the parameter value
          valueArray.push(val);           // and append it to the array
        } else {
          //
          // Process the parameter value as an object of the form:
          //  { operator: value }
          // with separate code for 'is', 'in' and 'tween' operators
          //
          for (var op in query[col]) {    // else traverse sub-object 
            o = op;                       // copy the operator so it can be isolated from - prefix
            if (op.charAt(0) == "-") {    // if - prefix then
              negate = 1;                 //   set negate flag
              o = op.substring(1);        //   strip prefix
            }
            //
            // Select the corresponding SQL operator for the one from the URI
            //
            if (operators.includes(o)) {
              sql = sql + sqlop[negate][operators.indexOf(o)];
            } else {
              sql = sql + "= ";           // default to = if not found
            }
            if (o == "is") {
              //
              // Code for the 'is' operator
              //
              sql = sql + "NULL ";        // use literal NULL & ignore value
            } else if (o == "tween") {
              //
              // Code for the 'tween' operator
              //
              sql = sql + subs + (substitution++) + " AND " + subs + (substitution++) + " ";
              val = getValue(query[col][op]);
              var varr = val.split(":");
              if (varr[0] != undefined) {
                valueArray.push(varr[0]);
                if (varr[1] != undefined) {
                  valueArray.push(varr[1])
                } else {
                  throw "ERROR: missing value parameter";
                } 
              } else {
                throw "ERROR: missing value parameter";
              };
            } else if (o == "in") {
              //
              // Code for the 'in' operator
              //
              let first = true;
              val = getValue(query[col][op]);
              val.split(":").forEach(function(value) {
                sql = sql + (first?"":", ") + subs + (substitution++);
                valueArray.push(value);
                first = false;
              });
              sql = sql + ") ";
            } else {
              //
              // Code for all other operators (=, !=, <, >, etc.)
              //
              sql = sql + subs + (substitution++) + " ";
              val = getValue(query[col][op]);
              valueArray.push(val);
            }
          }
        };
      }
    }
    //
    // Append any sort clause then return
    //
    sql = sql + sort;
    return {'sql': sql, 'values': valueArray};
  }
  
  module.exports = {
    uri2sql,
    setsubs
  }
