import React from 'react';
import { debounce } from 'lodash';

export class Legacy extends React.Component {
  componentWillMount() {
    this.timer = setTimeout(() => {}, 10);
  }
  render() {
    return <div>{debounce(() => {}, 100) ? 'a' : 'b'}</div>;
  }
}
