import React from 'react';

// 测试文件里的老写法不该进产品代码的体量账与废弃 API 账
export class LegacyTest extends React.Component {
  componentWillMount() {
    this.ready = true;
  }
  render() {
    return null;
  }
}
